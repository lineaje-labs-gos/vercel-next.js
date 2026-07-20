import nextFontGoogleFontLoader from './loader'
import { fetchResource } from './fetch-resource'
import * as Log from 'next/dist/build/output/log'

jest.mock('./fetch-resource')
jest.mock('next/dist/build/output/log')

const mockFetchResource = fetchResource as jest.Mock
const mockLogError = Log.error as jest.Mock

describe('next/font/google loader', () => {
  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('URL from options', () => {
    const fixtures: Array<[string, any, string]> = [
      [
        'Inter',
        {},
        'https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap',
      ],
      [
        'Inter',
        { weight: '400' },
        'https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap',
      ],
      [
        'Inter',
        { weight: '900', display: 'block' },
        'https://fonts.googleapis.com/css2?family=Inter:wght@900&display=block',
      ],
      [
        'Source_Sans_3',
        { weight: '900', display: 'auto' },
        'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@900&display=auto',
      ],
      [
        'Source_Sans_3',
        { weight: '200', style: 'italic' },
        'https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@1,200&display=swap',
      ],
      [
        'Roboto_Flex',
        { display: 'swap' },
        'https://fonts.googleapis.com/css2?family=Roboto+Flex:wght@100..1000&display=swap',
      ],
      [
        'Roboto_Flex',
        { display: 'fallback', weight: 'variable', axes: ['opsz'] },
        'https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,100..1000&display=fallback',
      ],
      [
        'Roboto_Flex',
        {
          display: 'optional',
          axes: ['YTUC', 'slnt', 'wdth', 'opsz', 'XTRA', 'YTAS'],
        },
        'https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,slnt,wdth,wght,XTRA,YTAS,YTUC@8..144,-10..0,25..151,100..1000,323..603,649..854,528..760&display=optional',
      ],
      [
        'Oooh_Baby',
        { weight: '400' },
        'https://fonts.googleapis.com/css2?family=Oooh+Baby:wght@400&display=swap',
      ],
      [
        'Albert_Sans',
        { weight: 'variable', style: 'italic' },
        'https://fonts.googleapis.com/css2?family=Albert+Sans:ital,wght@1,100..900&display=swap',
      ],
      [
        'Fraunces',
        { weight: 'variable', style: 'italic', axes: ['WONK', 'opsz', 'SOFT'] },
        'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@1,9..144,100..900,0..100,0..1&display=swap',
      ],
      [
        'Molle',
        { weight: '400' },
        'https://fonts.googleapis.com/css2?family=Molle:ital,wght@1,400&display=swap',
      ],
      [
        'Roboto',
        { weight: ['500', '300', '400'], style: ['normal', 'italic'] },
        'https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&display=swap',
      ],
      [
        'Roboto Mono',
        { style: ['italic', 'normal'] },
        'https://fonts.googleapis.com/css2?family=Roboto+Mono:ital,wght@0,100..700;1,100..700&display=swap',
      ],
      [
        'Fraunces',
        {
          style: ['normal', 'italic'],
          axes: ['WONK', 'opsz', 'SOFT'],
        },
        'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,100..900,0..100,0..1;1,9..144,100..900,0..100,0..1&display=swap',
      ],
      [
        'Poppins',
        { weight: ['900', '400', '100'] },
        'https://fonts.googleapis.com/css2?family=Poppins:wght@100;400;900&display=swap',
      ],
      [
        'Nabla',
        {},
        'https://fonts.googleapis.com/css2?family=Nabla&display=swap',
      ],
      [
        'Nabla',
        { axes: ['EDPT', 'EHLT'] },
        'https://fonts.googleapis.com/css2?family=Nabla:EDPT,EHLT@0..200,0..24&display=swap',
      ],
      [
        'Ballet',
        {},
        'https://fonts.googleapis.com/css2?family=Ballet&display=swap',
      ],
    ]
    test.each(fixtures)(
      '%s',
      async (
        functionName: string,
        fontFunctionArguments: any,
        expectedUrl: any
      ) => {
        mockFetchResource.mockResolvedValue(Buffer.from('OK'))
        const { css } = await nextFontGoogleFontLoader({
          functionName,
          data: [
            {
              adjustFontFallback: false,
              subsets: [],
              ...fontFunctionArguments,
            },
          ],
          emitFontFile: jest.fn(),
          resolve: jest.fn(),
          loaderContext: {} as any,
          isDev: false,
          isServer: true,
          variableName: 'myFont',
        })
        expect(css).toBe('OK')
        expect(mockFetchResource).toHaveBeenCalledTimes(1)
        expect(mockFetchResource).toHaveBeenCalledWith(
          expectedUrl,
          false,
          expect.stringContaining('Failed to fetch font')
        )
      }
    )
  })

  describe('when Google Fonts is unreachable', () => {
    it('falls back to a local font in dev instead of failing', async () => {
      mockFetchResource.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
      const { css } = await nextFontGoogleFontLoader({
        functionName: 'Inter',
        // Unique weight so the URL doesn't collide with the cssCache warmed by
        // the fixtures above.
        data: [{ weight: '500', adjustFontFallback: false, subsets: [] }],
        emitFontFile: jest.fn(),
        resolve: jest.fn(),
        loaderContext: {} as any,
        isDev: true,
        isServer: true,
        variableName: 'myFont',
      })
      expect(css).toContain("font-family: 'Inter Fallback'")
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining('Using fallback font instead')
      )
    })

    it('throws during build so the failure is not silently shipped', async () => {
      mockFetchResource.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
      await expect(
        nextFontGoogleFontLoader({
          functionName: 'Inter',
          data: [{ weight: '600', adjustFontFallback: false, subsets: [] }],
          emitFontFile: jest.fn(),
          resolve: jest.fn(),
          loaderContext: {} as any,
          isDev: false,
          isServer: true,
          variableName: 'myFont',
        })
      ).rejects.toThrow()
    })
  })
})
