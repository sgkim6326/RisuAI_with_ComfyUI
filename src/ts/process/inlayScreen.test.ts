import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))
vi.mock('./files/inlays', () => ({ writeInlayImage: vi.fn() }))
vi.mock('./visualManager', () => ({
    recordVisualImageDecision: vi.fn(),
    recordVisualImageGenerated: vi.fn(),
    resolveVisualSceneReferences: vi.fn((_char:character, _chat:character['chats'][number], spec:ImgGenSceneSpec) => ({
        characterIds:spec.characters.map((character:{id?:string}) => character.id).filter(Boolean),
        locationIds:['room-1'],
        sceneSpec:JSON.stringify({ ...spec, resolvedCharacters:spec.characters.map((character:{id?:string}) => ({...character, resolvedId:character.id})) }),
        unresolvedReferences:[]
    }))
}))

import { generateAIImage } from './stableDiff'
import { writeInlayImage } from './files/inlays'
import { recordVisualImageDecision, recordVisualImageGenerated, resolveVisualSceneReferences } from './visualManager'
import { runInlayScreen, updateInlayScreen } from './inlayScreen'
import type { character } from '../storage/database.svelte'
import { visualManagerInstructionTemplate } from './visualPromptInstructions'
import type { ImgGenSceneSpec } from './visualSceneSpec'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('inlay image command processing', () => {
    test('generates only the first ImgGen command in a response', async () => {
        vi.mocked(generateAIImage).mockImplementation(async (_prompt, _char, _negative, _type, options) => {
            options?.onPromptPrepared?.('prepared final English prompt')
            return 'data:image/png;base64,abc'
        })
        vi.mocked(writeInlayImage).mockResolvedValue('generated-id')
        const chat = { message:[], localLore:[], name:'Chat A', note:'' } as unknown as character['chats'][number]
        const char = {
            inlayViewScreen:true,
            viewScreen:'imggen',
            newGenData:{ prompt:'best quality, {{slot}}', negative:'' },
            chats:[chat],
            chatPage:0
        } as character
        const response = 'Narrative.\n<ImgGen="Alice smiles in a garden">\n<ImgGen="another scene">'

        const result = runInlayScreen(char, response, { chat, messageId:'message-1' })
        const output = await result.promise

        expect(result.text).toContain('[Generating...]')
        expect(generateAIImage).toHaveBeenCalledTimes(1)
        expect(generateAIImage).toHaveBeenCalledWith(
            'best quality, Alice smiles in a garden', char, '', 'inlay',
            expect.objectContaining({ onPromptPrepared:expect.any(Function) })
        )
        expect(output).toContain('{{inlay::generated-id}}')
        expect(output).not.toContain('another scene')
        expect(recordVisualImageGenerated).toHaveBeenCalledWith(
            char, chat, 'generated-id', 'prepared final English prompt', 'message-1'
        )
    })

    test('keeps the curly-brace ImgGen syntax working for older chats', async () => {
        vi.mocked(generateAIImage).mockResolvedValue('data:image/png;base64,abc')
        vi.mocked(writeInlayImage).mockResolvedValue('legacy-curly-image')
        const char = {
            inlayViewScreen:true,
            viewScreen:'imggen',
            newGenData:{ prompt:'best quality, {{slot}}', negative:'' }
        } as character

        const result = runInlayScreen(char, 'Text {{ImgGen="Alice waves"}}')
        const output = await result.promise

        expect(generateAIImage).toHaveBeenCalledWith(
            'best quality, Alice waves',
            char,
            '',
            'inlay',
            expect.objectContaining({ onPromptPrepared:expect.any(Function) })
        )
        expect(output).toContain('{{inlay::legacy-curly-image}}')
    })

    test('leaves normal messages untouched when no ImgGen command is present', () => {
        const char = {
            inlayViewScreen:true,
            viewScreen:'imggen',
            newGenData:{ prompt:'best quality, {{slot}}', negative:'' }
        } as character

        expect(runInlayScreen(char, 'No illustration is needed.')).toEqual({ text:'No illustration is needed.' })
        expect(generateAIImage).not.toHaveBeenCalled()
    })

    test('parses structured ImgGenJSON and carries stable character IDs through image storage', async () => {
        vi.mocked(generateAIImage).mockImplementation(async (_prompt, _char, _negative, _type, options) => {
            options?.onPromptPrepared?.('Alice, smiling in the garden, consistent style')
            return 'data:image/png;base64,abc'
        })
        vi.mocked(writeInlayImage).mockResolvedValue('structured-image')
        const chat = { message:[], localLore:[], name:'Chat A', note:'' } as unknown as character['chats'][number]
        const char = {
            inlayViewScreen:true,
            viewScreen:'imggen',
            newGenData:{ prompt:'best quality, {{slot}}', negative:'' },
            chats:[chat],
            chatPage:0
        } as character
        const response = '<ImgGenJSON>{"characters":[{"id":"alice-1","name":"Alice","action":"smiling","expression":"calm"}],"scene":{"location":"Old Garden","lighting":"soft moonlight","camera":"wide shot","direction":"quiet reunion"}}</ImgGenJSON>'
        const result = runInlayScreen(char, response, { chat, messageId:'message-2', visualUpdate:Promise.resolve() })
        const output = await result.promise

        expect(resolveVisualSceneReferences).toHaveBeenCalled()
        expect(generateAIImage).toHaveBeenCalledWith(
            expect.stringContaining('Characters: Alice (action: smiling; expression: calm)'),
            char,
            '',
            'inlay',
            expect.objectContaining({ visualContext:expect.objectContaining({characterIds:['alice-1']}) })
        )
        expect(recordVisualImageGenerated).toHaveBeenCalledWith(
            char,
            chat,
            'structured-image',
            'Alice, smiling in the garden, consistent style',
            'message-2',
            expect.objectContaining({ characterIds:['alice-1'], locationIds:['room-1'] })
        )
        expect(output).toContain('{{inlay::structured-image}}')
    })

    test('strips invalid ImgGenJSON without invoking or breaking the legacy image path', () => {
        const char = {
            inlayViewScreen:true,
            viewScreen:'imggen',
            newGenData:{ prompt:'best quality, {{slot}}', negative:'' }
        } as character
        const result = runInlayScreen(char, 'Text <ImgGenJSON>{"characters":[]}</ImgGenJSON>')

        expect(result.text).toBe('Text ')
        expect(result.promise).toBeUndefined()
        expect(generateAIImage).not.toHaveBeenCalled()
        expect(recordVisualImageDecision).toHaveBeenCalledWith(char, expect.stringContaining('validation failed'))
    })

    test('preserves CHARX custom instructions while initializing image generation defaults', () => {
        const char = {
            viewScreen:'imggen',
            inlayViewScreen:true,
            newGenData:{
                prompt:'custom prefix, {{slot}}',
                negative:'custom negative',
                instructions:'Existing CHARX image instructions',
                emotionInstructions:''
            }
        } as character

        updateInlayScreen(char)

        expect(char.viewScreen).toBe('imggen')
        expect(char.inlayViewScreen).toBe(true)
        expect(char.newGenData?.prompt).toBe('custom prefix, {{slot}}')
        expect(char.newGenData?.negative).toBe('custom negative')
        expect(char.newGenData?.instructions).toBe('Existing CHARX image instructions')
        expect(visualManagerInstructionTemplate).toContain('Do not generate an image for every response')
    })
})
