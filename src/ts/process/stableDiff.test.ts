import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertError: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ globalFetch: vi.fn(), readImage: vi.fn() }))
vi.mock('../kei/kei', () => ({ keiServerURL: '' }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn() }))
vi.mock('../stores.svelte', () => ({ CharEmotion: { set: vi.fn() } }))
vi.mock('./processzip', () => ({ processZip: vi.fn() }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('./visualManager', () => ({
  prepareVisualImagePrompt: vi.fn(async (prompt: string) => prompt),
  recordVisualImageDecision: vi.fn()
}))

import { applyImageOrientation } from './stableDiff'
import { generateAIImage } from './stableDiff'
import { stableDiff } from './stableDiff'
import { alertError } from '../alert'
import { globalFetch } from '../globalApi.svelte'
import { getDatabase, type character } from '../storage/database.svelte'
import { requestChatData } from './request/request'
import { prepareVisualImagePrompt } from './visualManager'
import { imagePromptDecisionInstruction, visualManagerInstructionTemplate } from './visualPromptInstructions'

beforeEach(() => {
  vi.clearAllMocks()
})

const comfyWorkflow = JSON.stringify({
  '1': {
    inputs: {
      text: '{{risu_prompt}}',
      negative: '{{risu_neg}}',
      seed: 1
    }
  }
})

function setupComfy(apiToken = '') {
  const db = {
    sdProvider: 'comfyui',
    comfyUiUrl: 'http://localhost:8188',
    comfyConfig: {
      workflow: comfyWorkflow,
      posNodeID: '',
      posInputName: 'text',
      negNodeID: '',
      negInputName: 'text',
      timeout: 5,
      apiToken
    }
  }
  vi.mocked(getDatabase).mockReturnValue(db as ReturnType<typeof getDatabase>)
}

function response(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, data, headers: {}, status }
}

async function mockSuccessfulGeneration(historyResults: unknown[] = [{
  'job-id': { outputs: { '1': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } }
}]) {
  vi.mocked(globalFetch).mockResolvedValueOnce(response({ prompt_id: 'job-id' }))
  for (const history of historyResults) {
    vi.mocked(globalFetch).mockResolvedValueOnce(response(history))
  }
  vi.mocked(globalFetch).mockResolvedValueOnce(response(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
}

describe('ComfyUI image generation', () => {
  test('preserves the prior standalone image instruction when Visual Manager is disabled', async () => {
    setupComfy()
    vi.mocked(requestChatData).mockResolvedValue({ type:'success', result:'NO_IMAGE' })
    const char = {
      visualManagerSettings:{ enabled:false, autoAnalyze:false, maxCharacters:20, maxLocations:10, recentMessages:50, debug:false },
      newGenData:{ instructions:'Existing custom image instructions', prompt:'best quality, {{slot}}', negative:'', emotionInstructions:'' }
    } as character

    await expect(stableDiff(char, 'a routine conversation')).resolves.toBe(false)

    expect(vi.mocked(requestChatData).mock.calls[0][0].formated[0].content).toBe('Existing custom image instructions')
  })

  test('does not duplicate the optional-illustration policy in the image-model request', async () => {
    setupComfy()
    vi.mocked(requestChatData).mockResolvedValue({ type:'success', result:'NO_IMAGE' })
    const char = {
      visualManagerSettings:{ enabled:true, autoAnalyze:true, maxCharacters:20, maxLocations:10, recentMessages:50, debug:false },
      newGenData:{ instructions:visualManagerInstructionTemplate, prompt:'best quality, {{slot}}', negative:'', emotionInstructions:'' }
    } as character

    await stableDiff(char, 'a scene')

    const systemPrompt = vi.mocked(requestChatData).mock.calls[0][0].formated[0].content
    expect(systemPrompt.match(/Do not generate an image for every response/g)).toHaveLength(1)
    expect(systemPrompt).not.toContain(imagePromptDecisionInstruction)
  })

  test('preserves custom instructions and adds the default decision policy only when absent', async () => {
    setupComfy()
    vi.mocked(requestChatData).mockResolvedValue({ type:'success', result:'NO_IMAGE' })
    const char = {
      visualManagerSettings:{ enabled:true, autoAnalyze:true, maxCharacters:20, maxLocations:10, recentMessages:50, debug:false },
      newGenData:{ instructions:'Keep my established custom image rules.', prompt:'best quality, {{slot}}', negative:'', emotionInstructions:'' }
    } as character

    await stableDiff(char, 'a scene')

    const systemPrompt = vi.mocked(requestChatData).mock.calls[0][0].formated[0].content
    expect(systemPrompt).toContain('Keep my established custom image rules.')
    expect(systemPrompt.match(/Decide whether the supplied latest roleplay context/g)).toHaveLength(1)
  })

  test('sends the Visual Manager prompt to ComfyUI without changing workflow fields', async () => {
    setupComfy()
    await mockSuccessfulGeneration()
    vi.mocked(prepareVisualImagePrompt).mockResolvedValueOnce('scene prompt [visual identity]')

    await generateAIImage('scene prompt', {} as character, 'negative prompt', 'inlay')

    expect(prepareVisualImagePrompt).toHaveBeenCalledWith('scene prompt', {})
    expect(globalFetch).toHaveBeenCalledWith(
      expect.stringContaining('/prompt'),
      expect.objectContaining({
        body: expect.objectContaining({
          prompt: expect.objectContaining({
            '1': { inputs: expect.objectContaining({ text:'scene prompt [visual identity]' }) }
          })
        })
      })
    )
  })

  test('sends the configured token through proxy for prompt, history, and binary image requests', async () => {
    setupComfy('test-api-token')
    await mockSuccessfulGeneration([
      {},
      { 'job-id': { outputs: { '1': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } }
    ])

    const result = await generateAIImage('a prompt', {} as character, 'negative prompt', 'inlay')

    expect(result).toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`)
    expect(globalFetch).toHaveBeenCalledTimes(4)
    const calls = vi.mocked(globalFetch).mock.calls
    expect(calls.map(([url]) => new URL(url).pathname)).toEqual(['/prompt', '/history', '/history', '/view'])
    for (const [, options] of calls) {
      expect(options.headers?.Authorization).toBe('Bearer test-api-token')
      expect(options.plainFetchDeforce).toBe(true)
    }
    expect(calls[0][1].body).toMatchObject({
      prompt: {
        '1': {
          inputs: {
            text: 'a prompt',
            negative: 'negative prompt'
          }
        }
      }
    })
    expect(calls[0][1].body.prompt['1'].inputs.seed).toBeGreaterThanOrEqual(0)
    expect(calls[0][1].body.prompt['1'].inputs.seed).toBeLessThan(1_000_000_000)
    expect(calls[3][1].rawResponse).toBe(true)
    expect(calls.map(([url]) => url).join(' ')).not.toContain('test-api-token')
  })

  test('keeps unauthenticated ComfyUI compatible when no token is configured', async () => {
    setupComfy()
    await mockSuccessfulGeneration()

    await generateAIImage('a prompt', {} as character, 'negative prompt', 'inlay')

    for (const [, options] of vi.mocked(globalFetch).mock.calls) {
      expect(options.headers?.Authorization).toBeUndefined()
    }
  })

  test('reports authentication failures immediately without polling history', async () => {
    setupComfy('invalid-token')
    vi.mocked(globalFetch).mockResolvedValueOnce(response({ error: 'Authentication required.' }, 401))

    await expect(generateAIImage('a prompt', {} as character, '', 'inlay')).resolves.toBe(false)

    expect(vi.mocked(globalFetch).mock.calls).toHaveLength(1)
    expect(vi.mocked(alertError)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('authentication failed') })
    )
  })

  test('distinguishes history failures from image download failures', async () => {
    setupComfy()
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(response({ prompt_id: 'job-id' }))
      .mockResolvedValueOnce(response({ error: 'history unavailable' }, 503))

    await expect(generateAIImage('a prompt', {} as character, '', 'inlay')).resolves.toBe(false)
    expect(vi.mocked(alertError)).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining('history lookup failed (HTTP 503)') })
    )

    vi.clearAllMocks()
    setupComfy()
    vi.mocked(globalFetch)
      .mockResolvedValueOnce(response({ prompt_id: 'job-id' }))
      .mockResolvedValueOnce(response({
        'job-id': { outputs: { '1': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } }
      }))
      .mockResolvedValueOnce(response({ error: 'image unavailable' }, 404))

    await expect(generateAIImage('a prompt', {} as character, '', 'inlay')).resolves.toBe(false)
    expect(vi.mocked(alertError)).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining('image download failed (HTTP 404)') })
    )
  })
})

describe('applyImageOrientation', () => {
  test('keeps configured dimensions without an orientation', () => {
    expect(applyImageOrientation(1024, 640)).toEqual({ height: 640, width: 1024 })
  })

  test('places the longer edge on the width for landscape', () => {
    expect(applyImageOrientation(640, 1024, 'landscape')).toEqual({ height: 640, width: 1024 })
  })

  test('places the longer edge on the height for portrait', () => {
    expect(applyImageOrientation(1024, 640, 'portrait')).toEqual({ height: 1024, width: 640 })
  })
})
