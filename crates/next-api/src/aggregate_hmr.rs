//! Server HMR updates computed against what the server runtimes have loaded.
//!
//! Server HMR pulls are lazy and per route, but every route that runs in a
//! runtime shares its module cache, and a chunk that loads doesn't replace a
//! factory the runtime already has. So a route's update can't be computed from
//! what that route saw before: a module it shares with routes loaded earlier
//! may still run the code it had back then. Instead, the caller records the
//! versions of the chunks the runtimes actually loaded, plus the module hashes
//! that applied updates installed, and each pull diffs the requested route's
//! chunks against that.

use std::{
    fmt::Display,
    sync::{Arc, LazyLock},
};

use anyhow::{Result, bail};
use serde::Serialize;
use turbo_frozenmap::FrozenSet;
use turbo_rcstr::RcStr;
use turbo_tasks::{
    FxIndexMap, FxIndexSet, NonLocalValue, ReadRef, ResolvedVc, TransientInstance, TryJoinIterExt,
    Vc,
    debug::ValueDebugFormat,
    message_queue::{CompilationEvent, Severity},
    turbo_tasks,
};
use turbo_tasks_hash::hash_xxh3_hash128;
use turbopack_core::{chunk::ModuleId, update_instruction::UpdateInstruction};
pub use turbopack_ecmascript::hmr::version::EcmascriptChunkVersion;
use turbopack_ecmascript::{
    chunk_list::{
        merged_update::{
            EcmascriptMergedChunkPartial, EcmascriptMergedChunkUpdate, EcmascriptMergedUpdate,
            EcmascriptModuleEntry,
        },
        update::EcmascriptUpdateInstruction,
    },
    hmr::EcmascriptHmrChunkContent,
};
use turbopack_nodejs::ecmascript::node::entry::chunk_list_content::EcmascriptBuildNodeChunkListContent;

#[derive(Clone, PartialEq, Eq, ValueDebugFormat, NonLocalValue)]
pub struct ServerHmrChunkList {
    pub relative_path: RcStr,
    pub versioned_content: ResolvedVc<EcmascriptBuildNodeChunkListContent>,
}

#[turbo_tasks::value(transparent, serialization = "skip")]
#[derive(Clone)]
pub struct ServerHmrChunkLists(Vec<ServerHmrChunkList>);

impl ServerHmrChunkLists {
    pub fn new(chunk_lists: Vec<ServerHmrChunkList>) -> Self {
        Self(chunk_lists)
    }

    pub fn as_slice(&self) -> &[ServerHmrChunkList] {
        &self.0
    }

    pub fn retain_entry_paths(&mut self, entry_paths: &FxIndexSet<RcStr>) {
        self.0
            .retain(|chunk_list| entry_paths.contains(&chunk_list.relative_path));
    }
}

/// Module hashes installed by applied updates, by chunk output directory.
///
/// Every output directory is served by its own runtime, with its own module
/// cache. A chunk that loads after an update keeps the updated factories, so
/// these take precedence over the versions of loaded chunks.
#[derive(Clone, Debug, Default, PartialEq, Eq, ValueDebugFormat, NonLocalValue)]
pub struct ServerHmrAppliedModules(FxIndexMap<RcStr, FxIndexMap<ModuleId, u128>>);

impl ServerHmrAppliedModules {
    fn get(&self, dir: &str, id: &ModuleId) -> Option<u128> {
        self.0.get(dir).and_then(|modules| modules.get(id)).copied()
    }

    fn insert(&mut self, dir: &str, id: ModuleId, hash: u128) {
        self.0.entry(dir.into()).or_default().insert(id, hash);
    }

    /// Forgets what was applied to the runtimes of `dirs`, e.g. because they were replaced by new
    /// runtimes without any installed factories.
    pub fn remove_dirs<'a>(&mut self, dirs: impl IntoIterator<Item = &'a str>) {
        for dir in dirs {
            self.0.shift_remove(dir);
        }
    }
}

/// What the server runtimes have installed, as recorded by the caller.
///
/// Only chunks whose factories were actually installed are part of it. Chunks that were merely
/// reported, or whose load is still pending, are not: they install their factories when they
/// load, and the caller reconciles them then, before their modules are evaluated.
#[derive(Default, NonLocalValue)]
pub struct ServerHmrLoadedState {
    /// The version of every chunk a runtime installed, as reported by the chunk itself when it
    /// loaded, or brought up to date by an applied update.
    pub chunks: Vec<ReadRef<EcmascriptChunkVersion>>,
    /// Chunks a runtime installed at a version that isn't known, e.g. because its version was
    /// never reported. They may have installed any module of their runtime directory at any
    /// code.
    pub uncertain_chunks: FxIndexSet<RcStr>,
    pub applied: ServerHmrAppliedModules,
    /// The chunk paths the requested route reported in its previous pull, if any. A chunk it
    /// gained since is not loaded with it anymore, since the route's modules already were.
    pub previous_route_chunks: Option<FxIndexSet<RcStr>>,
}

/// One chunk of the requested route, captured in the snapshot whose files were written.
#[derive(Clone, PartialEq, Eq, ValueDebugFormat, NonLocalValue)]
pub struct ServerHmrRouteChunk {
    pub content: ResolvedVc<Box<dyn EcmascriptHmrChunkContent>>,
    pub version: ReadRef<EcmascriptChunkVersion>,
    /// The id of `version`, which the chunk file reports when it loads.
    pub version_id: RcStr,
}

/// Reads the JavaScript chunks of `chunk_lists`, with their versions.
///
/// Call this inside the operation whose effects write the chunks, so that the versions belong to
/// the written files.
pub async fn server_hmr_route_chunks(
    chunk_lists: &[ServerHmrChunkList],
) -> Result<Vec<ServerHmrRouteChunk>> {
    let mut chunks = FxIndexMap::default();
    for chunk_list in chunk_lists {
        for (path, content) in chunk_list.versioned_content.await?.chunks_contents() {
            // Other chunks are not loaded as JavaScript, so there is nothing to update.
            if let Some(content) =
                ResolvedVc::try_sidecast::<Box<dyn EcmascriptHmrChunkContent>>(*content)
            {
                chunks.entry(path.clone()).or_insert(content);
            }
        }
    }
    chunks
        .into_values()
        .map(async |content| {
            let version = content.ecmascript_chunk_version().await?;
            Ok(ServerHmrRouteChunk {
                content,
                version_id: version.id_sync(),
                version,
            })
        })
        .try_join()
        .await
}

/// The input of [`server_hmr_loaded_update_operation`].
#[derive(NonLocalValue)]
pub struct ServerHmrLoadedUpdateInput {
    pub chunks: Vec<ServerHmrRouteChunk>,
    pub loaded: ServerHmrLoadedState,
}

/// The update for one route, computed against [`ServerHmrLoadedState`].
#[turbo_tasks::value(serialization = "skip", shared)]
pub struct ServerHmrLoadedUpdate {
    /// The current versions of the route's chunks. The caller records them as loaded when
    /// their chunks load, and for already loaded chunks once the update is applied.
    pub chunk_versions: Vec<ReadRef<EcmascriptChunkVersion>>,
    /// The ids of `chunk_versions`, as the chunk files report them when they load.
    pub chunk_version_ids: Vec<RcStr>,
    /// The update to apply, if the runtimes hold any outdated module of the route.
    pub instruction: Option<UpdateInstruction>,
    /// [`ServerHmrLoadedState::applied`] once the update is applied.
    pub applied: ServerHmrAppliedModules,
    /// The chunks whose factories the update installs, so that the caller records them as loaded
    /// once it is applied.
    pub installed_chunks: Vec<RcStr>,
}

static TRACE_DIFFING: LazyLock<bool> = LazyLock::new(|| {
    cfg!(debug_assertions) && std::env::var_os("NEXT_TEST_SERVER_HMR_DIFFING").is_some()
});

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerHmrChunkListDiffEvent {
    #[serde(rename = "entryPath")]
    chunk_list_path: RcStr,
}

impl Display for ServerHmrChunkListDiffEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Diffing server HMR entry {}", self.chunk_list_path)
    }
}

impl CompilationEvent for ServerHmrChunkListDiffEvent {
    fn type_name(&self) -> &'static str {
        "ServerHmrEntryDiffEvent"
    }

    fn severity(&self) -> Severity {
        Severity::Trace
    }

    fn message(&self) -> String {
        self.to_string()
    }

    fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server HMR entry diff event serializes")
    }
}

/// Reports which chunk lists a pull diffs, for tests that check that pulls stay per route.
pub fn trace_server_hmr_diffs(chunk_lists: &[ServerHmrChunkList]) {
    if *TRACE_DIFFING {
        for chunk_list in chunk_lists {
            turbo_tasks().send_compilation_event(Arc::new(ServerHmrChunkListDiffEvent {
                chunk_list_path: chunk_list.relative_path.clone(),
            }));
        }
    }
}

/// Diffs the route chunks of `input` against its loaded state.
///
/// Kept outside of the snapshot operation so that the loaded state, which changes with every
/// pull, never becomes part of a cached task. The chunk versions come from the snapshot whose
/// files were written. Module code is read here and may be newer than them, so the hashes of
/// the code that is actually shipped are what is recorded as applied.
#[turbo_tasks::function(operation, root)]
pub async fn server_hmr_loaded_update_operation(
    input: TransientInstance<ServerHmrLoadedUpdateInput>,
) -> Result<Vc<ServerHmrLoadedUpdate>> {
    let ServerHmrLoadedUpdateInput { chunks, loaded } = &*input;
    let plans = plan_server_hmr_update(chunks.iter().map(|chunk| &*chunk.version), loaded);

    let mut entries = FxIndexMap::default();
    let mut shipped = Vec::new();
    let mut chunk_updates = FxIndexMap::default();
    for ServerHmrRouteChunk {
        content, version, ..
    } in chunks
    {
        let Some(plan) = plans.get(&version.chunk_path) else {
            continue;
        };
        if !plan.ship.is_empty() {
            let chunk_entries = content.entries().await?;
            let dir = chunk_dir(&version.chunk_path);
            for id in &plan.ship {
                // Separate cells can observe different executions while recomputing; fail the
                // pull so that the caller recovers, instead of claiming a module wasn't shipped.
                let Some(entry) = chunk_entries.get(id) else {
                    bail!(
                        "Module {id} of chunk {} is missing from its server HMR entries",
                        version.chunk_path
                    );
                };
                if !entries.contains_key(id) {
                    entries.insert(
                        id.clone(),
                        EcmascriptModuleEntry::from_code(id, *entry.code, &version.chunk_path)
                            .await?,
                    );
                }
                shipped.push((dir, id.clone()));
            }
        }
        chunk_updates.insert(
            version.chunk_path.clone(),
            EcmascriptMergedChunkUpdate::Partial(EcmascriptMergedChunkPartial {
                added: FrozenSet::from_iter(plan.added.iter().cloned()),
                deleted: FrozenSet::from_iter(plan.deleted.iter().cloned()),
            }),
        );
    }

    let applied = applied_after_update(&loaded.applied, &shipped, &entries);

    // Membership changes alone don't change what runs: added modules are either installed or
    // shipped, and the Node.js runtime keeps factories of deleted modules.
    let instruction = (!entries.is_empty()).then(|| {
        UpdateInstruction::new(EcmascriptUpdateInstruction::Merged(
            EcmascriptMergedUpdate {
                entries: entries.into_iter().collect(),
                chunks: chunk_updates.into_iter().collect(),
            },
        ))
    });

    Ok(ServerHmrLoadedUpdate {
        chunk_versions: chunks.iter().map(|chunk| chunk.version.clone()).collect(),
        chunk_version_ids: chunks
            .iter()
            .map(|chunk| chunk.version_id.clone())
            .collect(),
        installed_chunks: plans
            .iter()
            .filter(|(_, plan)| plan.installs)
            .map(|(path, _)| path.clone())
            .collect(),
        instruction,
        applied,
    }
    .cell())
}

/// Output-root-relative directory of a chunk. Each directory has its own runtime.
fn chunk_dir(chunk_path: &str) -> &str {
    chunk_path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// The applied module hashes once an update shipping `shipped` (by runtime directory) with
/// `entries` is applied.
///
/// The code of an entry is read after the snapshot and may be newer than the chunk versions, and
/// a module shipped for several runtime directories is sent once, so the hashes are taken from
/// the code that is actually sent.
fn applied_after_update(
    applied: &ServerHmrAppliedModules,
    shipped: &[(&str, ModuleId)],
    entries: &FxIndexMap<ModuleId, EcmascriptModuleEntry>,
) -> ServerHmrAppliedModules {
    let mut applied = applied.clone();
    for (dir, id) in shipped {
        if let Some(entry) = entries.get(id) {
            applied.insert(dir, id.clone(), hash_xxh3_hash128(&entry.code));
        }
    }
    applied
}

/// What one of the requested chunks needs.
#[derive(Debug, Default, PartialEq, Eq)]
struct ChunkPlan {
    /// Modules whose code must be shipped.
    ship: Vec<ModuleId>,
    /// Modules added to an already loaded chunk.
    added: Vec<ModuleId>,
    /// Modules removed from an already loaded chunk.
    deleted: Vec<ModuleId>,
    /// Whether the update installs the chunk: it isn't loaded and won't load on its own.
    installs: bool,
}

/// The state of a module in a runtime, compared to its current hash.
enum RuntimeModule {
    /// The runtime has no factory for the module that we know of.
    Unknown,
    /// The runtime runs the current code.
    Current,
    /// The runtime runs other code, or might.
    Outdated,
}

/// The hashes of every module in `versions`, by chunk directory and module id.
fn hashes_by_module<'a>(
    versions: impl Iterator<Item = &'a EcmascriptChunkVersion>,
) -> FxIndexMap<(&'a str, &'a ModuleId), Vec<u128>> {
    let mut hashes = FxIndexMap::<_, Vec<_>>::default();
    for version in versions {
        let dir = chunk_dir(&version.chunk_path);
        for (id, hash) in &version.entries_hashes {
            hashes.entry((dir, id)).or_default().push(*hash);
        }
    }
    hashes
}

/// Decides which modules of the requested chunks must be shipped.
///
/// A module is shipped when the runtime of its chunk's directory may run other code than its
/// current one:
/// - Its factory may come from any loaded chunk, and the runtime kept the first one it got, so any
///   loaded hash that differs counts as outdated.
/// - Hashes installed by applied updates take precedence, since loading a chunk doesn't replace
///   factories.
///
/// A module that no loaded chunk holds is installed when its chunk loads, so it is only shipped
/// when its chunk is loaded already. In a runtime directory with uncertain chunks, a module is
/// only current when an applied update installed its current code. Loaded chunks that aren't
/// requested are left alone.
fn plan_server_hmr_update<'a>(
    requested: impl IntoIterator<Item = &'a EcmascriptChunkVersion>,
    loaded: &ServerHmrLoadedState,
) -> FxIndexMap<RcStr, ChunkPlan> {
    let mut loaded_by_path = FxIndexMap::default();
    for version in &loaded.chunks {
        loaded_by_path.insert(&*version.chunk_path, &**version);
    }
    let loaded_hashes = hashes_by_module(loaded_by_path.values().copied());
    let uncertain_dirs = loaded
        .uncertain_chunks
        .iter()
        .map(|path| chunk_dir(path))
        .collect::<FxIndexSet<_>>();
    let runtime_module = |dir: &str, id: &ModuleId, hash: u128| {
        if let Some(applied) = loaded.applied.get(dir, id) {
            return if applied == hash {
                RuntimeModule::Current
            } else {
                RuntimeModule::Outdated
            };
        }
        if uncertain_dirs.contains(dir) {
            return RuntimeModule::Outdated;
        }
        match loaded_hashes.get(&(dir, id)) {
            None => RuntimeModule::Unknown,
            Some(hashes) if hashes.iter().all(|loaded| *loaded == hash) => RuntimeModule::Current,
            Some(_) => RuntimeModule::Outdated,
        }
    };

    let mut plans = FxIndexMap::default();
    for version in requested {
        if plans.contains_key(&version.chunk_path) {
            continue;
        }
        let dir = chunk_dir(&version.chunk_path);
        let loaded_version = loaded_by_path.get(&*version.chunk_path);
        // A chunk that a route gained after it was loaded won't load with the route anymore, so
        // the update installs it.
        let installs = loaded_version.is_none()
            && loaded
                .previous_route_chunks
                .as_ref()
                .is_some_and(|previous| !previous.contains(&version.chunk_path));
        let mut plan = ChunkPlan {
            installs,
            ..Default::default()
        };
        for (id, hash) in &version.entries_hashes {
            let in_loaded_version =
                loaded_version.is_some_and(|loaded| loaded.entries_hashes.contains_key(id));
            if loaded_version.is_some() && !in_loaded_version {
                plan.added.push(id.clone());
            }
            match runtime_module(dir, id, *hash) {
                RuntimeModule::Outdated => plan.ship.push(id.clone()),
                // The chunk won't load (again), so its new modules must be shipped.
                RuntimeModule::Unknown if loaded_version.is_some() || installs => {
                    plan.ship.push(id.clone())
                }
                RuntimeModule::Unknown | RuntimeModule::Current => {}
            }
        }
        if let Some(loaded_version) = loaded_version {
            plan.deleted.extend(
                loaded_version
                    .entries_hashes
                    .keys()
                    .filter(|id| !version.entries_hashes.contains_key(*id))
                    .cloned(),
            );
        }
        if plan != ChunkPlan::default() {
            plans.insert(version.chunk_path.clone(), plan);
        }
    }
    plans
}

#[cfg(test)]
mod tests {
    use turbo_rcstr::RcStr;
    use turbo_tasks::{FxIndexMap, FxIndexSet, ReadRef};
    use turbo_tasks_fs::rope::Rope;
    use turbo_tasks_hash::hash_xxh3_hash128;
    use turbopack_core::chunk::{MinifyType, ModuleId};
    use turbopack_ecmascript::{
        chunk_list::merged_update::EcmascriptModuleEntry, hmr::version::EcmascriptChunkVersion,
    };

    use super::{
        ChunkPlan, ServerHmrAppliedModules, ServerHmrLoadedState, applied_after_update,
        plan_server_hmr_update,
    };

    fn id(name: &str) -> ModuleId {
        ModuleId::String(name.into())
    }

    fn chunk(path: &str, modules: &[(&str, u128)]) -> ReadRef<EcmascriptChunkVersion> {
        ReadRef::new_owned(EcmascriptChunkVersion {
            chunk_path: path.into(),
            minify_type: MinifyType::NoMinify,
            entries_hashes: modules
                .iter()
                .map(|(name, hash)| (id(name), *hash))
                .collect(),
        })
    }

    fn plan(
        requested: &[ReadRef<EcmascriptChunkVersion>],
        loaded: ServerHmrLoadedState,
    ) -> FxIndexMap<String, ChunkPlan> {
        plan_server_hmr_update(requested.iter().map(|version| &**version), &loaded)
            .into_iter()
            .map(|(path, plan)| (path.to_string(), plan))
            .collect()
    }

    fn loaded_chunks(chunks: &[ReadRef<EcmascriptChunkVersion>]) -> ServerHmrLoadedState {
        ServerHmrLoadedState {
            chunks: chunks.to_vec(),
            ..Default::default()
        }
    }

    fn ship(ids: &[&str]) -> ChunkPlan {
        ChunkPlan {
            ship: ids.iter().map(|name| id(name)).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn nothing_loaded_ships_nothing() {
        let requested = [chunk("server/chunks/b.js", &[("shared", 2), ("b", 1)])];
        assert!(plan(&requested, loaded_chunks(&[])).is_empty());
    }

    #[test]
    fn module_loaded_at_the_same_hash_is_not_shipped() {
        let requested = [chunk("server/chunks/b.js", &[("shared", 1), ("b", 1)])];
        let loaded = [chunk("server/chunks/a.js", &[("shared", 1), ("a", 1)])];
        assert!(plan(&requested, loaded_chunks(&loaded)).is_empty());
    }

    #[test]
    fn module_loaded_at_another_hash_through_another_chunk_is_shipped() {
        let requested = [chunk("server/chunks/b.js", &[("shared", 2), ("b", 1)])];
        let loaded = [chunk("server/chunks/a.js", &[("shared", 1), ("a", 1)])];
        assert_eq!(
            plan(&requested, loaded_chunks(&loaded)),
            FxIndexMap::from_iter([("server/chunks/b.js".into(), ship(&["shared"]))])
        );
    }

    #[test]
    fn module_loaded_at_several_hashes_is_shipped() {
        let requested = [chunk("server/chunks/c.js", &[("shared", 2)])];
        let loaded = [
            chunk("server/chunks/a.js", &[("shared", 1)]),
            chunk("server/chunks/b.js", &[("shared", 2)]),
        ];
        assert_eq!(
            plan(&requested, loaded_chunks(&loaded)),
            FxIndexMap::from_iter([("server/chunks/c.js".into(), ship(&["shared"]))])
        );
    }

    #[test]
    fn applied_hash_takes_precedence_over_loaded_chunks() {
        let requested = [chunk("server/chunks/b.js", &[("shared", 1)])];
        let mut applied = ServerHmrAppliedModules::default();
        applied.insert("server/chunks", id("shared"), 2);
        let state = || ServerHmrLoadedState {
            applied: applied.clone(),
            ..loaded_chunks(&[chunk("server/chunks/a.js", &[("shared", 1)])])
        };
        assert_eq!(
            plan(&requested, state()),
            FxIndexMap::from_iter([("server/chunks/b.js".into(), ship(&["shared"]))])
        );

        let requested = [chunk("server/chunks/b.js", &[("shared", 2)])];
        assert!(plan(&requested, state()).is_empty());
    }

    #[test]
    fn unknown_module_of_an_unloaded_chunk_is_not_shipped() {
        let requested = [chunk("server/chunks/b.js", &[("new", 1)])];
        let loaded = [chunk("server/chunks/a.js", &[("a", 1)])];
        assert!(plan(&requested, loaded_chunks(&loaded)).is_empty());
    }

    #[test]
    fn loaded_chunk_ships_its_changes_and_new_modules() {
        let requested = [chunk(
            "server/chunks/a.js",
            &[("a", 2), ("kept", 1), ("new", 1)],
        )];
        let loaded = [chunk(
            "server/chunks/a.js",
            &[("a", 1), ("kept", 1), ("removed", 1)],
        )];
        assert_eq!(
            plan(&requested, loaded_chunks(&loaded)),
            FxIndexMap::from_iter([(
                "server/chunks/a.js".into(),
                ChunkPlan {
                    ship: vec![id("a"), id("new")],
                    added: vec![id("new")],
                    deleted: vec![id("removed")],
                    installs: false,
                }
            )])
        );
    }

    #[test]
    fn module_added_to_a_loaded_chunk_is_not_shipped_when_already_current() {
        let requested = [chunk("server/chunks/a.js", &[("a", 1), ("moved", 1)])];
        let loaded = [
            chunk("server/chunks/a.js", &[("a", 1)]),
            chunk("server/chunks/b.js", &[("moved", 1)]),
        ];
        assert_eq!(
            plan(&requested, loaded_chunks(&loaded)),
            FxIndexMap::from_iter([(
                "server/chunks/a.js".into(),
                ChunkPlan {
                    added: vec![id("moved")],
                    ..Default::default()
                }
            )])
        );
    }

    #[test]
    fn uncertain_directory_ships_modules_without_a_current_applied_hash() {
        // The uncertain chunk may have installed any module of its directory at any code.
        let requested = [
            chunk("server/chunks/b.js", &[("shared", 1), ("b", 1)]),
            chunk("server/chunks/ssr/c.js", &[("other", 1)]),
        ];
        let mut applied = ServerHmrAppliedModules::default();
        applied.insert("server/chunks", id("b"), 1);
        let state = ServerHmrLoadedState {
            uncertain_chunks: FxIndexSet::from_iter([RcStr::from("server/chunks/lazy.js")]),
            applied,
            ..loaded_chunks(&[
                chunk("server/chunks/b.js", &[("shared", 1), ("b", 1)]),
                chunk("server/chunks/ssr/c.js", &[("other", 1)]),
            ])
        };
        assert_eq!(
            plan(&requested, state),
            FxIndexMap::from_iter([("server/chunks/b.js".into(), ship(&["shared"]))])
        );
    }

    #[test]
    fn applied_hashes_are_the_hashes_of_the_shipped_code() {
        let entry = EcmascriptModuleEntry {
            code: Rope::from("shipped code"),
            url: "server/chunks/a.js?id=shared".into(),
            map: None,
        };
        let entries = FxIndexMap::from_iter([(id("shared"), entry.clone())]);
        // The module is sent once, for both runtime directories.
        let applied = applied_after_update(
            &ServerHmrAppliedModules::default(),
            &[
                ("server/chunks", id("shared")),
                ("server/chunks/ssr", id("shared")),
            ],
            &entries,
        );
        let hash = hash_xxh3_hash128(&entry.code);
        assert_eq!(applied.get("server/chunks", &id("shared")), Some(hash));
        assert_eq!(applied.get("server/chunks/ssr", &id("shared")), Some(hash));
    }

    #[test]
    fn applied_modules_of_a_replaced_runtime_are_forgotten() {
        // A new runtime has none of the factories that were applied to the one it replaced.
        let mut applied = ServerHmrAppliedModules::default();
        applied.insert("server/chunks", id("shared"), 2);
        applied.insert("server/chunks/ssr", id("shared"), 2);
        applied.remove_dirs(["server/chunks"]);
        let requested = [chunk("server/chunks/a.js", &[("shared", 2)])];
        let state = ServerHmrLoadedState {
            applied,
            ..loaded_chunks(&[chunk("server/chunks/a.js", &[("shared", 1)])])
        };
        assert_eq!(
            plan(&requested, state),
            FxIndexMap::from_iter([("server/chunks/a.js".into(), ship(&["shared"]))])
        );
    }

    #[test]
    fn chunk_a_loaded_route_gained_is_installed() {
        // The route's entry already ran, so a chunk it gained since won't load with it.
        let requested = [
            chunk("server/chunks/entry.js", &[("page", 1)]),
            chunk("server/chunks/gained.js", &[("action", 1), ("page", 1)]),
        ];
        let state = ServerHmrLoadedState {
            previous_route_chunks: Some(FxIndexSet::from_iter([RcStr::from(
                "server/chunks/entry.js",
            )])),
            ..loaded_chunks(&[chunk("server/chunks/entry.js", &[("page", 1)])])
        };
        assert_eq!(
            plan(&requested, state),
            FxIndexMap::from_iter([(
                "server/chunks/gained.js".into(),
                ChunkPlan {
                    // `page` is installed already, so it isn't shipped again.
                    ship: vec![id("action")],
                    installs: true,
                    ..Default::default()
                }
            )])
        );
    }

    #[test]
    fn unloaded_chunks_are_not_a_baseline() {
        // Only installed chunks count: a requested chunk's unknown modules are installed when
        // it loads.
        let requested = [chunk("server/chunks/new.js", &[("proxy", 2)])];
        let loaded = [chunk("server/chunks/a.js", &[("a", 1)])];
        assert!(plan(&requested, loaded_chunks(&loaded)).is_empty());
    }

    #[test]
    fn output_directories_are_separate_runtimes() {
        let requested = [chunk("server/chunks/ssr/b.js", &[("shared", 2)])];
        let loaded = [chunk("server/chunks/a.js", &[("shared", 1)])];
        assert!(plan(&requested, loaded_chunks(&loaded)).is_empty());
    }

    #[test]
    fn loaded_chunks_that_are_not_requested_are_left_alone() {
        let requested = [chunk("server/chunks/b.js", &[("b", 1)])];
        let loaded = [chunk("server/chunks/a.js", &[("a", 1)])];
        assert!(plan(&requested, loaded_chunks(&loaded)).is_empty());
    }
}
