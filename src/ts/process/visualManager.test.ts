import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../storage/database.svelte', () => ({
    getDatabase: vi.fn(),
    invalidateVisualAssetCatalog: vi.fn((char:character) => {
        char.visualAssetCatalogRevision = (char.visualAssetCatalogRevision ?? 0) + 1
    })
}))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ readImage: vi.fn() }))
vi.mock('./files/inlays', () => ({
    getInlayAsset: vi.fn(async () => ({
        type:'image',
        ext:'png',
        name:'generated',
        data:`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`
    }))
}))
vi.mock('../model/modellist', () => ({
    getModelInfo: vi.fn(),
    LLMFlags: { hasImageInput:'hasImageInput' },
    ProviderNames: new Map()
}))

import { getDatabase, invalidateVisualAssetCatalog, type character, type Chat, type loreBook } from '../storage/database.svelte'
import { requestChatData } from './request/request'
import { readImage } from '../globalApi.svelte'
import { getInlayAsset } from './files/inlays'
import { getModelInfo, LLMFlags } from '../model/modellist'
import {
    analyzeVisualMemory,
    analyzeVisualResponse,
    analyzeReferencedVisualAssets,
    analyzeVisualAssetIfNeeded,
    createVisualCharacterProfile,
    createVisualLocationProfile,
    getChatVisualMemory,
    getVisualCharacterAssets,
    getVisualAssetCatalogStats,
    getVisualLorebookCatalog,
    prepareVisualImagePrompt,
    recordVisualImageGenerated,
    resolveVisualSceneReferences,
    resolveChatAssetReferences,
    setCurrentVisualOutfit
} from './visualManager'
import { compileSceneSpecPrompt, parseImgGenSceneSpec } from './visualSceneSpec'

type TestCharacter = character
let baseChar:TestCharacter

function makeCharacter():TestCharacter {
    return {
        type:'character',
        chaId:'main',
        name:'Main',
        chats:[{
            message:[{ role:'user', data:'Alice enters the old library.' }],
            localLore:[],
            name:'Chat A',
            note:''
        }],
        chatPage:0,
        globalLore:[],
        desc:''
    } as TestCharacter
}

function setupDatabase(characters:character[] = [baseChar]):ReturnType<typeof getDatabase> {
    const database = {
        characters,
        subModel:'vision-test',
        seperateModelsForAxModels:false
    } as ReturnType<typeof getDatabase>
    vi.mocked(getDatabase).mockReturnValue(database)
    return database
}

function enableVisuals(char:TestCharacter, overrides:Partial<NonNullable<character['visualManagerSettings']>> = {}):void {
    char.visualManagerSettings = {
        enabled:true,
        autoAnalyze:true,
        maxCharacters:20,
        maxLocations:10,
        recentMessages:50,
        debug:false,
        ...overrides
    }
}

function modelResponse(data:Record<string, unknown>):void {
    vi.mocked(requestChatData).mockResolvedValue({ type:'success', result:JSON.stringify(data) })
}

beforeEach(() => {
    vi.clearAllMocks()
    baseChar = makeCharacter()
    setupDatabase()
    vi.mocked(getModelInfo).mockReturnValue({ flags:[LLMFlags.hasImageInput] } as ReturnType<typeof getModelInfo>)
    vi.mocked(readImage).mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    vi.mocked(getInlayAsset).mockResolvedValue({
        type:'image',
        ext:'png',
        name:'generated',
        data:`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`
    })
})

describe('Visual Manager profile lookup and analysis', () => {
    test('discovers CHARX image assets from names without changing the source asset', () => {
        const char = makeCharacter()
        char.ccAssets = [{ type:'portrait', name:'Alice portrait', ext:'png', uri:'assets/alice.png' }]

        const assets = getVisualCharacterAssets(char)

        expect(assets).toEqual([{ name:'Alice portrait', extension:'png', uri:'assets/alice.png', kind:'charx' }])
        expect(char.ccAssets[0].uri).toBe('assets/alice.png')
    })

    test('reuses unchanged asset metadata and rebuilds after asset-list mutations', () => {
        const char = makeCharacter()
        char.ccAssets = Array.from({length:1000}, (_, index) => ({
            type:'image',
            name:`asset-${index}`,
            ext:'png',
            uri:`asset-${index}.png`
        }))

        const firstIndex = getVisualCharacterAssets(char)
        const firstStats = getVisualAssetCatalogStats(char)
        const secondIndex = getVisualCharacterAssets(char)
        expect(secondIndex).toBe(firstIndex)
        expect(getVisualAssetCatalogStats(char)).toEqual(firstStats)

        char.ccAssets.push({ type:'image', name:'new asset', ext:'png', uri:'new.png' })
        expect(getVisualCharacterAssets(char)).toHaveLength(1001)
        expect(getVisualAssetCatalogStats(char)).toEqual({ builds:2, entriesVisited:2001 })

        char.additionalAssets = [['First name', 'first.png', 'png']]
        const beforeRename = getVisualCharacterAssets(char)
        char.additionalAssets[0][0] = 'Updated name'
        invalidateVisualAssetCatalog(char)
        const afterRename = getVisualCharacterAssets(char)
        expect(afterRename).not.toBe(beforeRename)
        expect(afterRename.at(-1)?.name).toBe('Updated name')

        char.emotionImages = [['happy', 'happy.png']]
        const beforeEmotionRename = getVisualCharacterAssets(char)
        char.emotionImages[0][0] = 'joyful'
        invalidateVisualAssetCatalog(char)
        const afterEmotionRename = getVisualCharacterAssets(char)
        expect(afterEmotionRename).not.toBe(beforeEmotionRename)
        expect(afterEmotionRename.at(-1)?.name).toBe('joyful')
    })

    test('avoids repeated metadata traversal for messages in a 1000-asset character', async () => {
        const char = makeCharacter()
        char.ccAssets = Array.from({length:1000}, (_, index) => ({
            type:'image',
            name:`asset-${index}`,
            ext:'png',
            uri:`asset-${index}.png`
        }))
        char.chats[0].message = [{ role:'user', data:'ordinary lowercase text' }]
        enableVisuals(char)

        const coldStart = performance.now()
        await analyzeVisualResponse(char, char.chats[0])
        const coldDuration = performance.now() - coldStart
        expect(char.chats[0].visualMemory?.lastAnalysisMetrics?.assetMetadataCount).toBe(1000)
        expect(getVisualAssetCatalogStats(char)).toMatchObject({ builds:1, entriesVisited:1000 })

        const warmStart = performance.now()
        for(let index = 0; index < 20; index++) {
            char.chats[0].message.push({ role:'user', data:`ordinary lowercase text ${index}` })
            await analyzeVisualResponse(char, char.chats[0])
            expect(char.chats[0].visualMemory?.lastAnalysisMetrics?.assetMetadataCount).toBe(0)
        }
        const warmAverage = (performance.now() - warmStart) / 20
        expect(getVisualAssetCatalogStats(char)).toMatchObject({ builds:1, entriesVisited:1000 })
        console.info(`Visual asset catalog benchmark (1000 assets): cold=${coldDuration.toFixed(3)}ms; warm event average=${warmAverage.toFixed(3)}ms; warm metadata entries visited=0`)
    })

    test('resolves chat-referenced CHARX, additional, and emotion assets but excludes generated inlays', () => {
        const char = makeCharacter()
        char.ccAssets = [{ type:'portrait', name:'Alice portrait', ext:'png', uri:'assets/alice.png' }]
        char.additionalAssets = [['Lantern', 'assets/lantern.png', 'png']]
        char.emotionImages = [['happy', 'assets/happy.png']]
        char.chats[0].message = [{
            role:'char',
            data:'{{asset::Alice portrait}} {{asset::Lantern}} {{emotion::happy}} {{inlay::rendered-image}}'
        }]

        expect(resolveChatAssetReferences(char.chats[0], char).map(asset => asset.kind)).toEqual([
            'charx', 'additional', 'emotion'
        ])
    })

    test('lazily analyzes a named character asset once and persists the structured cache', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.ccAssets = [{ type:'portrait', name:'Alice portrait', ext:'png', uri:'assets/alice.png' }]
        const profile = createVisualCharacterProfile(char.chaId, char.name, 'asset')
        profile.assetUri = char.ccAssets[0].uri
        profile.assetName = char.ccAssets[0].name
        modelResponse({
            style:{medium:'digital illustration', artStyle:'soft anime', lineArt:'fine linework'},
            face:{shape:'oval'},
            eye:{color:'green'},
            hair:{color:'silver', length:'long'},
            body:{skin:'fair'},
            clothing:{presets:{casual:{name:'casual',description:'blue coat'}},defaultPreset:'casual'}
        })

        await analyzeVisualAssetIfNeeded(char, profile)

        expect(requestChatData).toHaveBeenCalledTimes(1)
        const userMessage = vi.mocked(requestChatData).mock.calls[0][0].formated[1]
        expect(userMessage.multimodals?.[0]).toMatchObject({
            type:'image',
            base64:`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`
        })
        expect(profile.visionAnalysisStatus).toBe('complete')
        expect(profile.style.artStyle).toBe('soft anime')
        expect(profile.hair.color).toBe('silver')
        expect(profile.clothing.presets.casual.description).toBe('blue coat')
        expect(char.visualAssetProfiles?.[0]).toBe(profile)

        expect(readImage).toHaveBeenCalledTimes(1)
        await analyzeVisualAssetIfNeeded(char, profile)
        expect(requestChatData).toHaveBeenCalledTimes(1)
        expect(readImage).toHaveBeenCalledTimes(1)
    })

    test('only reads the explicitly referenced asset from a large catalog', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.ccAssets = Array.from({length:1000}, (_, index) => ({
            type:'image',
            name:index === 537 ? 'Alice portrait' : `unrelated-${index}`,
            ext:'png',
            uri:`assets/${index}.png`
        }))
        char.chats[0].message = [{ role:'char', data:'{{asset::Alice portrait}}' }]
        enableVisuals(char)
        modelResponse({ hair:{color:'silver'} })

        await analyzeReferencedVisualAssets(char, char.chats[0])

        expect(readImage).toHaveBeenCalledTimes(1)
        expect(vi.mocked(readImage).mock.calls[0][0]).toBe('assets/537.png')
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })

    test('does not call an LLM when the selected submodel has no Vision support', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.ccAssets = [{ type:'portrait', name:'Alice portrait', ext:'png', uri:'assets/alice.png' }]
        const profile = createVisualCharacterProfile(char.chaId, char.name, 'asset')
        profile.assetUri = char.ccAssets[0].uri
        vi.mocked(getModelInfo).mockReturnValue({ flags:[] } as ReturnType<typeof getModelInfo>)

        await analyzeVisualAssetIfNeeded(char, profile)

        expect(requestChatData).not.toHaveBeenCalled()
        expect(profile.visionAnalysisStatus).toBe('unavailable')
    })

    test('invalidates cached Vision results when image bytes or the selected model changes', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.ccAssets = [{ type:'portrait', name:'Alice portrait', ext:'png', uri:'assets/alice.png' }]
        const profile = createVisualCharacterProfile(char.chaId, char.name, 'asset')
        profile.assetUri = char.ccAssets[0].uri
        const database = setupDatabase([char])
        vi.mocked(readImage).mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]))
        modelResponse({ hair:{color:'silver'} })

        await analyzeVisualAssetIfNeeded(char, profile)
        const originalHash = profile.assetContentHash

        vi.mocked(readImage).mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]))
        await analyzeVisualAssetIfNeeded(char, profile, true)
        expect(profile.assetContentHash).not.toBe(originalHash)
        expect(requestChatData).toHaveBeenCalledTimes(2)

        database.subModel = 'vision-test-new-model'
        await analyzeVisualAssetIfNeeded(char, profile)
        expect(profile.visionModel).toBe('vision-test-new-model')
        expect(requestChatData).toHaveBeenCalledTimes(3)
    })

    test('translates non-English Vision fields before saving and disables reasoning only on analysis calls', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.image = 'assets/alice.png'
        const profile = createVisualCharacterProfile(char.chaId, char.name, 'asset')
        profile.assetUri = char.image
        vi.mocked(requestChatData)
            .mockResolvedValueOnce({ type:'success', result:JSON.stringify({ hair:{color:'은발'} }) })
            .mockResolvedValueOnce({ type:'success', result:JSON.stringify({ hair:{color:'silver'} }) })

        await analyzeVisualAssetIfNeeded(char, profile)

        expect(profile.hair.color).toBe('silver')
        expect(vi.mocked(requestChatData).mock.calls.every(([request]) => request.disableThinking === true)).toBe(true)
    })

    test('fails gracefully and caches Vision errors without changing character image data', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.ccAssets = [{ type:'portrait', name:'Alice portrait', ext:'png', uri:'assets/alice.png' }]
        const profile = createVisualCharacterProfile(char.chaId, char.name, 'asset')
        profile.assetUri = char.ccAssets[0].uri
        vi.mocked(requestChatData).mockResolvedValue({ type:'fail', result:'Vision unavailable' })
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

        await analyzeVisualAssetIfNeeded(char, profile)

        expect(profile.visionAnalysisStatus).toBe('failed')
        expect(profile.visionFailure).toContain('Vision unavailable')
        expect(char.ccAssets[0].uri).toBe('assets/alice.png')
        expect(warning).toHaveBeenCalled()
        warning.mockRestore()
    })

    test('connects recognized CHARX aliases without duplicating them in chat memory', async () => {
        const char = makeCharacter()
        char.chaId = 'asset-alice'
        char.name = 'Alice'
        char.nickname = 'Amy'
        char.chats[0].message = [{role:'user', data:'Amy arrives.'}]
        enableVisuals(char)
        setupDatabase([char])
        modelResponse({ characters:[{ name:'Amy', aliases:['A'], important:true, importance:9, appearance:{hair:{color:'silver'}} }] })

        await analyzeVisualMemory(char, char.chats[0])

        expect(char.chats[0].visualMemory?.characters).toHaveLength(0)
        expect(char.chats[0].visualMemory?.currentCharacterIds).toContain('asset-alice')
    })

    test('resolves known CHARX characters and lorebook places locally without an LLM call', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.globalLore = [{
            id:'library',
            comment:'Old Library',
            key:'library',
            secondkey:'',
            insertorder:0,
            content:'A quiet place with tall shelves.',
            mode:'constant',
            alwaysActive:false,
            selective:false
        }] as loreBook[]
        enableVisuals(char)

        await analyzeVisualMemory(char, char.chats[0])

        expect(requestChatData).not.toHaveBeenCalled()
        expect(char.chats[0].visualMemory?.currentCharacterIds).toContain(char.chaId)
        expect(char.chats[0].visualMemory?.currentLocationIds).toContain('character:main:library')
    })

    test('avoids applying a profile when an asset name is ambiguous', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.visualAssetProfiles = [createVisualCharacterProfile('second-alice','Alice','asset')]
        enableVisuals(char)
        setupDatabase([char])
        modelResponse({ characters:[{ name:'Alice', important:true, importance:9 }] })

        await analyzeVisualMemory(char, char.chats[0])

        expect(char.chats[0].visualMemory?.characters).toHaveLength(0)
        expect(char.chats[0].visualMemory?.currentCharacterIds).toHaveLength(0)
    })

    test('registers important newcomers and excludes one-time extras', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        modelResponse({
            characters:[
                { name:'Alice', important:true, importance:8, aliases:['Al'], appearance:{hair:{color:'silver'}} },
                { name:'Guard', important:false, oneTime:true, importance:1 }
            ],
            locations:[{ name:'Old Library', important:true, importance:8, lighting:'warm candlelight' }]
        })

        await analyzeVisualMemory(char, char.chats[0])

        const memory = char.chats[0].visualMemory!
        expect(memory.characters.map(profile => profile.name)).toEqual(['Alice'])
        expect(memory.characters[0].hair.color).toBe('silver')
        expect(memory.locations.map(profile => profile.name)).toEqual(['Old Library'])
    })

    test('registers Korean identities even when visual-language conversion returns invalid Korean fields', async () => {
        const char = makeCharacter()
        char.chats[0].message = [{ role:'char', chatId:'message-korean', data:'젬마가 새로운 손님을 맞이한다.' }]
        enableVisuals(char)
        vi.mocked(requestChatData)
            .mockResolvedValueOnce({
                type:'success',
                model:'vision-analysis-model',
                result:JSON.stringify({
                    characters:[{
                        name:'젬마',
                        aliases:['새 별칭'],
                        important:true,
                        importance:9,
                        sourceMessageId:'message-korean',
                        appearance:{hair:{color:'긴 은빛 머리'}}
                    }],
                    locations:[],
                    appearanceChanges:[]
                })
            })
            .mockResolvedValueOnce({
                type:'success',
                model:'translator-model',
                result:JSON.stringify({
                    characters:[{
                        name:'젬마',
                        aliases:['새 별칭'],
                        important:true,
                        importance:9,
                        sourceMessageId:'message-korean',
                        appearance:{hair:{color:'긴 은빛 머리'}}
                    }],
                    locations:[],
                    appearanceChanges:[]
                })
            })

        await analyzeVisualResponse(char, char.chats[0])

        const memory = char.chats[0].visualMemory!
        expect(memory.characters).toHaveLength(1)
        expect(memory.characters[0].name).toBe('젬마')
        expect(memory.characters[0].aliases).toContain('새 별칭')
        expect(memory.characters[0].hair.color).toBe('')
        expect(memory.currentCharacterIds).toEqual([memory.characters[0].id])
        expect(memory.lastVisualTranslationFailureKind).toBe('visual-language-conversion')
        expect(memory.lastAnalyzedFingerprint).toBeDefined()
        expect(memory.lastAnalysisModel).toBe('vision-analysis-model')
        expect(memory.lastAnalysisProvider).toBeDefined()
    })

    test('preserves one stable profile ID across an explicit accepted rename', async () => {
        const char = makeCharacter()
        char.chats[0].message = [{ role:'char', chatId:'message-first', data:'젬마가 문을 연다.' }]
        enableVisuals(char)
        modelResponse({ characters:[{ name:'젬마', important:true, importance:9, aliases:['별칭'] }] })
        await analyzeVisualMemory(char, char.chats[0])
        const memory = char.chats[0].visualMemory!
        const firstId = memory.characters[0].id

        char.chats[0].message.push({ role:'char', chatId:'message-rename', data:'젬마는 이제 하나라는 이름을 쓰기로 했고, 모두가 그 이름을 받아들였다.' })
        modelResponse({
            characters:[{
                name:'하나',
                aliases:['젬마'],
                renamedFrom:['젬마'],
                important:true,
                importance:9
            }]
        })
        await analyzeVisualMemory(char, char.chats[0])

        expect(memory.characters).toHaveLength(1)
        expect(memory.characters[0].id).toBe(firstId)
        expect(memory.characters[0].name).toBe('하나')
        expect(memory.characters[0].aliases).toContain('젬마')
        expect(memory.currentCharacterIds).toContain(firstId)
    })

    test('retries failed message analysis after a model change without advancing its success checkpoint', async () => {
        const char = makeCharacter()
        char.chats[0].message = [{ role:'char', chatId:'failed-message', data:'Aster enters the room.' }]
        enableVisuals(char)
        const database = setupDatabase([char])
        vi.mocked(requestChatData).mockResolvedValueOnce({ type:'fail', result:'PROHIBITED_CONTENT' })

        await analyzeVisualMemory(char, char.chats[0])
        const memory = char.chats[0].visualMemory!
        expect(memory.lastAnalysisFailureKind).toBe('provider-content-block')
        expect(memory.lastAnalyzedFingerprint).toBeUndefined()
        expect(memory.lastFailedAnalysisFingerprint).toBeDefined()

        await analyzeVisualMemory(char, char.chats[0])
        expect(requestChatData).toHaveBeenCalledTimes(1)

        database.subModel = 'replacement-analysis-model'
        modelResponse({ characters:[{ name:'Aster', important:true, importance:8 }] })
        await analyzeVisualMemory(char, char.chats[0])
        expect(requestChatData).toHaveBeenCalledTimes(2)
        expect(memory.characters[0].name).toBe('Aster')
        expect(memory.lastAnalyzedFingerprint).toBeDefined()
        expect(memory.lastFailedAnalysisFingerprint).toBeUndefined()
    })

    test('retries the anonymized saved-chat failure and reconnects prior image references', async () => {
        const char = makeCharacter()
        char.chats[0].message = [
            { role:'user', chatId:'m1', data:'Aster arrives at the station.' },
            { role:'char', chatId:'m2', data:'Aster introduces herself.' },
            { role:'user', chatId:'m3', data:'An illustration is requested.' },
            { role:'char', chatId:'m4', data:'A portrait of Aster appears.' },
            { role:'user', chatId:'m5', data:'Aster receives a new name.' },
            { role:'char', chatId:'m6', data:'Aster accepts the name Nova.' }
        ]
        enableVisuals(char)
        const memory = getChatVisualMemory(char.chats[0])
        memory.recentImages = [
            { id:'old-image-1', generatedAt:1, messageId:'m4', prompt:'A portrait of Aster.', characterIds:[], locationIds:[], profileVersions:{} },
            { id:'old-image-2', generatedAt:2, messageId:'m6', prompt:'A person at a station.', characterIds:[], locationIds:[], profileVersions:{} }
        ]
        memory.lastAnalysisResult = 'English visual profile conversion returned non-English descriptions.'
        memory.lastAnalyzedFingerprint = 'stale-failed-checkpoint'
        memory.lastAnalyzedMessageCount = 6
        modelResponse({
            characters:[{
                name:'Nova',
                aliases:['Aster'],
                renamedFrom:['Aster'],
                important:true,
                importance:9
            }]
        })

        await analyzeVisualMemory(char, char.chats[0])
        const profile = memory.characters[0]
        expect(profile.name).toBe('Nova')
        expect(profile.aliases).toContain('Aster')
        expect(vi.mocked(requestChatData).mock.calls[0][0].formated[1].content).toContain('m1')
        expect(memory.recentImages?.map(image => image.characterIds)).toEqual([[profile.id], [profile.id]])
        char.visualManagerSettings!.autoAnalyze = false
        recordVisualImageGenerated(char, char.chats[0], 'new-image-1', 'A portrait of Nova.')
        const linkedImage = memory.recentImages?.find(image => image.id === 'new-image-1')
        expect(linkedImage?.characterIds).toContain(profile.id)

        recordVisualImageGenerated(char, char.chats[0], 'new-image-2', 'A person at a station.', undefined, {
            characterIds:[profile.id],
            locationIds:[],
            sceneSpec:JSON.stringify({ characters:[{resolvedId:profile.id}] })
        })
        expect(memory.recentImages?.find(image => image.id === 'new-image-2')?.characterIds).toEqual([profile.id])
        const restoredMemory = JSON.parse(JSON.stringify(memory))
        expect(restoredMemory.characters[0].id).toBe(profile.id)
        expect(restoredMemory.recentImages.find((image:{id:string}) => image.id === 'new-image-2').characterIds).toEqual([profile.id])
    })

    test('filters people and rules from the lorebook location catalog', () => {
        const char = makeCharacter()
        char.globalLore = [
            { id:'person', comment:'[Main Character] Megumi', key:'megumi', secondkey:'', insertorder:0, content:'Character personality and appearance.', mode:'constant', alwaysActive:false, selective:false },
            { id:'rule', comment:'Magic system rules', key:'magic', secondkey:'', insertorder:0, content:'Worldbuilding rules.', mode:'constant', alwaysActive:false, selective:false },
            { id:'place', comment:'Old Library', key:'library', secondkey:'', insertorder:0, content:'A quiet library.', mode:'constant', alwaysActive:false, selective:false }
        ] as loreBook[]

        const locations = getVisualLorebookCatalog(char, char.chats[0])

        expect(locations.map(location => location.name)).toEqual(['Old Library'])
        expect(char.visualLoreClassificationCache?.['character:main:person'].classification).toBe('person')
        expect(char.visualLoreClassificationCache?.['character:main:rule'].classification).toBe('rule')
    })

    test('extracts visual details only for a relevant, confirmed physical location', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.globalLore = [{
            id:'library',
            comment:'Old Library',
            key:'library',
            secondkey:'',
            insertorder:0,
            content:'A large room with old oak shelves and warm lantern light.',
            mode:'constant',
            alwaysActive:false,
            selective:false
        }] as loreBook[]
        enableVisuals(char)
        modelResponse({
            entries:[{
                id:'character:main:library',
                classification:'place',
                profile:{
                    structure:'high wooden shelves',
                    interior:'a spacious reading room',
                    lighting:'warm lantern light',
                    colorPalette:'dark oak and amber',
                    atmosphere:'quiet and scholarly'
                }
            }]
        })

        const prompt = await prepareVisualImagePrompt('Alice stands in the Old Library.', char)

        expect(requestChatData).toHaveBeenCalledTimes(1)
        expect(prompt).toContain('Old Library: high wooden shelves')
        expect(prompt).toContain('warm lantern light')
    })

    test('replaces lower-importance entries but preserves pinned entries', async () => {
        const char = makeCharacter()
        enableVisuals(char, { maxCharacters:1 })
        char.chats[0].visualMemory = {
            characters:[{...createVisualCharacterProfile('old','Old'), importance:1, mentionCount:1, lastSeenMessage:0}],
            locations:[],
            currentCharacterIds:[],
            currentLocationIds:[],
            currentOutfits:{}
        }
        modelResponse({ characters:[{ name:'New', important:true, importance:9 }] })
        await analyzeVisualMemory(char, char.chats[0])
        expect(char.chats[0].visualMemory?.characters.map(profile => profile.name)).toEqual(['New'])

        char.chats[0].message.push({role:'user', data:'Another arrives.'})
        char.chats[0].visualMemory!.characters[0].pinned = true
        char.chats[0].visualMemory!.characters[0].currentScene = false
        modelResponse({ characters:[{ name:'Another', important:true, importance:10 }] })
        await analyzeVisualMemory(char, char.chats[0])
        expect(char.chats[0].visualMemory?.characters.map(profile => profile.name)).toEqual(['New'])
    })

    test('enforces the default-sized character and location buffers using importance', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const memory = getChatVisualMemory(char.chats[0])
        memory.characters = Array.from({length:20}, (_, index) => ({
            ...createVisualCharacterProfile(`person-${index}`, `Person ${index}`),
            importance:0,
            mentionCount:0,
            lastSeenMessage:0
        }))
        memory.locations = Array.from({length:10}, (_, index) => ({
            ...createVisualLocationProfile(`place-${index}`, `Place ${index}`),
            importance:0,
            mentionCount:0,
            lastSeenMessage:0
        }))
        modelResponse({
            characters:[{ name:'Important Person', important:true, importance:10 }],
            locations:[{ name:'Important Place', important:true, importance:10 }]
        })

        await analyzeVisualMemory(char, char.chats[0])

        expect(memory.characters).toHaveLength(20)
        expect(memory.characters.some(profile => profile.name === 'Important Person')).toBe(true)
        expect(memory.locations).toHaveLength(10)
        expect(memory.locations.some(profile => profile.name === 'Important Place')).toBe(true)
    })

    test('analyzes new messages once and invalidates the cache for edited messages', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const chat = char.chats[0]
        modelResponse({ characters:[] })
        await analyzeVisualMemory(char, chat)
        expect(vi.mocked(requestChatData)).toHaveBeenCalledTimes(1)

        chat.message.push({ role:'char', data:'Bob enters the new room.' })
        modelResponse({ characters:[] })
        await analyzeVisualMemory(char, chat)
        expect(vi.mocked(requestChatData)).toHaveBeenCalledTimes(2)
        expect(vi.mocked(requestChatData).mock.calls[1][0].formated[1].content).toContain('Bob enters the new room')
        expect(vi.mocked(requestChatData).mock.calls[1][0].formated[1].content).not.toContain('Alice enters')

        chat.message[0].data = 'Alice returns in a changed scene.'
        modelResponse({ characters:[] })
        await analyzeVisualMemory(char, chat)
        expect(vi.mocked(requestChatData)).toHaveBeenCalledTimes(3)
        expect(vi.mocked(requestChatData).mock.calls[2][0].formated[1].content).toContain('Alice returns')
    })

    test('preserves confirmed manual fields while filling unknown fields and current outfits', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const memory = getChatVisualMemory(char.chats[0])
        const alice = createVisualCharacterProfile('alice','Alice')
        alice.hair.color = 'silver'
        alice.manualFields = ['hair.color']
        memory.characters.push(alice)
        modelResponse({
            characters:[{
                name:'Alice',
                important:true,
                style:{artStyle:'ink illustration'},
                appearance:{hair:{color:'black'}},
                currentOutfit:'red jacket',
                outfitChanged:true,
                outfitIsCurrent:true
            }]
        })

        await analyzeVisualMemory(char, char.chats[0])

        expect(alice.hair.color).toBe('silver')
        expect(alice.style.artStyle).toBe('ink illustration')
        expect(memory.currentOutfits.alice).toBe('red jacket')
    })

    test('compiles structured scene details with resolved profile identity into the final image prompt', async () => {
        const char = makeCharacter()
        char.visualManagerSettings = {
            enabled:true,
            autoAnalyze:false,
            maxCharacters:20,
            maxLocations:10,
            recentMessages:50,
            debug:true
        }
        setupDatabase([char])
        const chat = char.chats[0]
        const memory = getChatVisualMemory(chat)
        const mira = createVisualCharacterProfile('mira-id', 'Mira')
        mira.style.artStyle = 'soft watercolor illustration'
        mira.face.shape = 'oval face'
        mira.hair.color = 'dark brown hair'
        memory.characters.push(mira)
        const garden = createVisualLocationProfile('garden-id', 'Moon Garden')
        garden.lighting = 'soft blue moonlight'
        memory.locations.push(garden)
        setCurrentVisualOutfit(chat, mira.id, 'a red traveling coat')
        const parsed = parseImgGenSceneSpec(JSON.stringify({
            characters:[{ id:'mira-id', name:'Mira', action:'kneeling beside a lantern', expression:'concerned' }],
            scene:{ location:{ id:'garden-id', name:'Moon Garden' }, camera:'medium shot', direction:'a quiet discovery' }
        }))
        expect(parsed.ok).toBe(true)
        if(!parsed.ok) return
        const context = resolveVisualSceneReferences(char, chat, parsed.value)
        const finalPrompt = await prepareVisualImagePrompt(compileSceneSpecPrompt(parsed.value), char, context)

        expect(finalPrompt).toContain('kneeling beside a lantern')
        expect(finalPrompt).toContain('soft watercolor illustration')
        expect(finalPrompt).toContain('oval face')
        expect(finalPrompt).toContain('dark brown hair')
        expect(finalPrompt).toContain('a red traveling coat')
        expect(finalPrompt).toContain('Moon Garden: soft blue moonlight')
        expect(memory.lastDebugSceneSpec).toContain('"resolvedId":"mira-id"')
        expect(memory.lastDebugPrompt).toBe(finalPrompt)
    })

    test('replays confirmed appearance changes and removes stale changes after message edits', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const chat = char.chats[0]
        chat.message = [{ role:'char', chatId:'message-1', data:'Alice dyes her hair black.' }]
        const memory = getChatVisualMemory(chat)
        const alice = createVisualCharacterProfile('alice','Alice')
        alice.hair.color = 'silver'
        memory.characters.push(alice)
        modelResponse({
            characters:[],
            appearanceChanges:[{
                character:'Alice',
                sourceMessageId:'message-1',
                field:'hair.color',
                value:'black',
                confirmedCurrent:true,
                persistent:true
            }]
        })

        await analyzeVisualMemory(char, chat)
        expect(memory.appearanceStates?.alice?.['hair.color']).toBe('black')

        chat.message[0].data = 'Alice smiles.'
        await analyzeVisualMemory(char, chat)
        expect(memory.stateChanges).toHaveLength(0)
        expect(memory.appearanceStates?.alice?.['hair.color']).toBeUndefined()
    })

    test('records an initial generated-image prompt once for an empty memory profile', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const chat = char.chats[0]
        chat.message[0].chatId = 'message-1'
        const memory = getChatVisualMemory(chat)
        const alice = createVisualCharacterProfile('alice', 'Alice')
        memory.characters.push(alice)
        memory.currentCharacterIds = ['alice']
        modelResponse({
            profiles:[{
                id:'alice',
                style:{artStyle:'soft anime'},
                appearance:{hair:{color:'silver'}, face:{shape:'round'}},
                conflicts:['face.shape'],
                currentOutfit:'red jacket',
                outfitIsCurrent:true
            }]
        })

        recordVisualImageGenerated(char, chat, 'image-1', 'Alice with silver hair, wearing a red jacket.', 'message-1')
        await vi.waitFor(() => expect(alice.initialImageVisionStatus).toBe('complete'))

        expect(alice.style.artStyle).toBe('soft anime')
        expect(alice.hair.color).toBe('silver')
        expect(alice.face.shape).toBe('')
        expect(alice.initialImageVisionStatus).toBe('complete')
        expect(alice.initialImageContentHash).toBeDefined()
        expect(memory.currentOutfits.alice).toBe('red jacket')
        expect(memory.lastConflictingFields).toContain('Alice.face.shape')
        expect(getInlayAsset).toHaveBeenCalledWith('image-1')
        expect(vi.mocked(requestChatData).mock.calls[0][0].formated[1].multimodals?.[0]).toMatchObject({
            type:'image',
            base64:`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`
        })
        expect(memory.recentImages).toHaveLength(1)
        expect(memory.recentImages?.[0]).toMatchObject({
            id:'image-1',
            messageId:'message-1',
            characterIds:['alice']
        })
        recordVisualImageGenerated(char, chat, 'image-1', 'Alice with silver hair.', 'message-1')
        await Promise.resolve()
        recordVisualImageGenerated(char, chat, 'image-2', 'Alice smiles in a garden.', 'message-2')
        await Promise.resolve()
        expect(requestChatData).toHaveBeenCalledTimes(1)
        expect(getInlayAsset).toHaveBeenCalledTimes(1)
        expect(memory.recentImages).toHaveLength(2)
    })

    test('analyzes the first standalone image even when prompt extraction already filled the profile', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const chat = char.chats[0]
        const memory = getChatVisualMemory(chat)
        const alice = createVisualCharacterProfile('alice', 'Alice')
        alice.style = { medium:'digital', artStyle:'anime', lineArt:'clean', shading:'soft', colorPalette:'cool', additional:'consistent' }
        alice.face = { shape:'oval', features:'small nose' }
        alice.eye = { color:'blue', shape:'almond', details:'bright' }
        alice.hair = { color:'silver', length:'long', style:'straight', details:'side part' }
        alice.body = { build:'slim', skin:'fair', proportions:'average', distinctiveFeatures:'none' }
        memory.characters.push(alice)
        memory.currentCharacterIds = ['alice']
        modelResponse({ profiles:[{ id:'alice', conflicts:['hair.color'], appearance:{hair:{color:'gold'}} }] })

        recordVisualImageGenerated(char, chat, 'image-filled-profile', 'Alice with silver hair, standing alone.')
        await vi.waitFor(() => expect(alice.initialImageVisionStatus).toBe('complete'))

        expect(getInlayAsset).toHaveBeenCalledWith('image-filled-profile')
        expect(requestChatData).toHaveBeenCalledTimes(1)
        expect(alice.hair.color).toBe('silver')
        expect(memory.lastConflictingFields).toContain('Alice.hair.color')
    })

    test('skips automatic Vision when a generated image contains multiple identified characters', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const chat = char.chats[0]
        const memory = getChatVisualMemory(chat)
        memory.characters.push(createVisualCharacterProfile('alice','Alice'), createVisualCharacterProfile('bob','Bob'))
        memory.currentCharacterIds = ['alice','bob']

        recordVisualImageGenerated(char, chat, 'group-image', 'Alice and Bob meet.')
        await Promise.resolve()

        expect(getInlayAsset).not.toHaveBeenCalled()
        expect(requestChatData).not.toHaveBeenCalled()
        expect(memory.characters.every(profile => !profile.initialImageVisionStatus)).toBe(true)
    })

    test('caches a failed first-image Vision attempt without affecting the saved image', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const chat = char.chats[0]
        const memory = getChatVisualMemory(chat)
        const alice = createVisualCharacterProfile('alice','Alice')
        memory.characters.push(alice)
        memory.currentCharacterIds = ['alice']
        vi.mocked(requestChatData).mockResolvedValue({ type:'fail', result:'Vision unavailable' })

        recordVisualImageGenerated(char, chat, 'image-failed', 'Alice in a garden.')
        await vi.waitFor(() => expect(alice.initialImageVisionStatus).toBe('failed'))
        recordVisualImageGenerated(char, chat, 'image-next', 'Alice smiles.')
        await Promise.resolve()

        expect(alice.initialImageVisionFailure).toContain('Vision unavailable')
        expect(memory.recentImages?.map(image => image.id)).toEqual(['image-failed','image-next'])
        expect(getInlayAsset).toHaveBeenCalledTimes(1)
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })

    test('uses the cached first image and prompt for profiles created by the earlier prompt-only pipeline', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const chat = char.chats[0]
        const memory = getChatVisualMemory(chat)
        const alice = createVisualCharacterProfile('alice','Alice')
        alice.initialImagePromptFingerprint = 'legacy-prompt-cache'
        alice.initialImageReferenceId = 'legacy-image'
        memory.characters.push(alice)
        memory.currentCharacterIds = ['alice']
        memory.recentImages = [{
            id:'legacy-image',
            generatedAt:1,
            prompt:'Alice with long silver hair, standing alone.',
            characterIds:['alice'],
            locationIds:[],
            profileVersions:{}
        }]
        modelResponse({ profiles:[{ id:'alice', appearance:{hair:{length:'long'}} }] })

        recordVisualImageGenerated(char, chat, 'new-image', 'Alice stands in a garden.')
        await vi.waitFor(() => expect(alice.initialImageVisionStatus).toBe('complete'))

        expect(getInlayAsset).toHaveBeenCalledWith('legacy-image')
        expect(vi.mocked(requestChatData).mock.calls[0][0].formated[1].content).toContain('Alice with long silver hair')
        expect(alice.initialImageReferenceId).toBe('legacy-image')
    })

    test('serializes first-image profile extraction without dropping another character', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        const chat = char.chats[0]
        const memory = getChatVisualMemory(chat)
        const alice = createVisualCharacterProfile('alice', 'Alice')
        const bob = createVisualCharacterProfile('bob', 'Bob')
        memory.characters.push(alice, bob)
        memory.currentCharacterIds = ['alice', 'bob']
        vi.mocked(requestChatData)
            .mockResolvedValueOnce({ type:'success', result:JSON.stringify({ profiles:[{ id:'alice', style:{ artStyle:'watercolor' } }] }) })
            .mockResolvedValueOnce({ type:'success', result:JSON.stringify({ profiles:[{ id:'bob', style:{ artStyle:'comic ink' } }] }) })

        recordVisualImageGenerated(char, chat, 'image-alice', 'Alice in a garden.')
        recordVisualImageGenerated(char, chat, 'image-bob', 'Bob at a station.')
        await vi.waitFor(() => {
            expect(alice.initialImageReferenceId).toBe('image-alice')
            expect(bob.initialImageReferenceId).toBe('image-bob')
        })

        expect(alice.style.artStyle).toBe('watercolor')
        expect(bob.style.artStyle).toBe('comic ink')
        expect(requestChatData).toHaveBeenCalledTimes(2)
    })

    test('keeps only five generated-image references per chat without affecting old inlays', () => {
        const char = makeCharacter()
        enableVisuals(char)
        const firstChat = char.chats[0]
        const secondChat = {
            message:[],
            localLore:[],
            name:'Chat B',
            note:''
        } as unknown as Chat

        for(let index = 1; index <= 6; index++) {
            recordVisualImageGenerated(char, firstChat, `image-${index}`, 'unrelated scene')
        }

        recordVisualImageGenerated(char, secondChat, 'other-chat-image', 'unrelated scene')

        expect(firstChat.visualMemory?.recentImages?.map(image => image.id)).toEqual([
            'image-2','image-3','image-4','image-5','image-6'
        ])
        expect(secondChat.visualMemory?.recentImages?.map(image => image.id)).toEqual(['other-chat-image'])
        expect(firstChat.message).toHaveLength(1)
        expect(firstChat.message[0].data).toContain('Alice')
    })
})

describe('Visual Manager prompt continuity', () => {
    test('analyzes the current CHARX avatar lazily, then uses its cached profile in the final prompt', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.image = 'assets/alice.png'
        char.visualManagerSettings = {
            enabled:true,
            autoAnalyze:true,
            maxCharacters:20,
            maxLocations:10,
            recentMessages:50,
            debug:true
        }
        modelResponse({
            style:{medium:'digital painting', artStyle:'watercolor anime', lineArt:'soft'},
            face:{shape:'round'},
            eye:{color:'blue'},
            hair:{color:'black', length:'short'},
            body:{skin:'warm brown'},
            clothing:{presets:{casual:{name:'casual',description:'white blouse'}},defaultPreset:'casual'}
        })

        const firstPrompt = await prepareVisualImagePrompt('Alice, a close portrait.', char)

        expect(firstPrompt).toContain('Alice: digital painting')
        expect(firstPrompt).toContain('watercolor anime')
        expect(firstPrompt).toContain('blue')
        expect(firstPrompt).toContain('white blouse')
        expect(requestChatData).toHaveBeenCalledTimes(2)
        expect(char.visualAssetProfiles?.[0].visionAnalysisStatus).toBe('complete')

        const secondPrompt = await prepareVisualImagePrompt('Alice in a different scene.', char)

        expect(secondPrompt).toContain('watercolor anime')
        expect(requestChatData).toHaveBeenCalledTimes(2)
    })

    test('adds only current identities and keeps clothing state isolated by chat', async () => {
        const char = makeCharacter()
        char.visualManagerSettings = {
            enabled:true, autoAnalyze:false, maxCharacters:20, maxLocations:10, recentMessages:50, debug:true
        }
        const chatA = char.chats[0]
        const chatB = { message:[], localLore:[], name:'Chat B', note:'' } as Chat
        const memoryA = getChatVisualMemory(chatA)
        const memoryB = getChatVisualMemory(chatB)
        const alice = createVisualCharacterProfile('alice','Alice','memory')
        alice.style.artStyle = 'watercolor illustration'
        alice.hair.color = 'silver'
        alice.clothing.presets.casual.description = 'blue coat'
        memoryA.characters.push(alice)
        const garden = createVisualLocationProfile('garden','Garden')
        garden.lighting = 'soft morning light'
        memoryA.locations.push(garden)
        const bob = {...makeCharacter(), chaId:'asset-bob', name:'Bob'}
        const bobProfile = createVisualCharacterProfile('asset-bob','Bob','asset')
        bobProfile.style.artStyle = 'ink drawing'
        char.visualAssetProfiles = [bobProfile]
        memoryA.currentCharacterIds = ['alice', 'asset-bob']
        memoryA.currentLocationIds = ['garden']
        setCurrentVisualOutfit(chatA, 'alice', 'red winter uniform')
        setCurrentVisualOutfit(chatB, 'alice', 'green swimwear')
        setupDatabase([char, bob])

        const prompt = await prepareVisualImagePrompt('Alice stands in the garden. An unrelated character waits.', char)

        expect(prompt).toContain('watercolor illustration')
        expect(prompt).toContain('red winter uniform')
        expect(prompt).toContain('Bob: ink drawing')
        expect(prompt).toContain('Garden: soft morning light')
        expect(prompt).not.toContain('green swimwear')
        expect(prompt).not.toContain('Character visual identity: unrelated character')
        expect(memoryA.lastDebugPrompt).toBe(prompt)
        expect(memoryB.currentOutfits.alice).toBe('green swimwear')
    })

    test('translates visual scene text to English while preserving identifiers and caching the result', async () => {
        const char = makeCharacter()
        char.name = '메구미'
        char.visualManagerSettings = {
            enabled:true, autoAnalyze:false, maxCharacters:20, maxLocations:10, recentMessages:50, debug:true
        }
        vi.mocked(requestChatData).mockResolvedValue({
            type:'success',
            result:'RISUENTITYTOKEN0X stands beneath a quiet moon.'
        })

        const first = await prepareVisualImagePrompt('메구미가 조용한 달 아래에 서 있다.', char)
        const second = await prepareVisualImagePrompt('메구미가 조용한 달 아래에 서 있다.', char)

        expect(first).toBe('메구미 stands beneath a quiet moon.')
        expect(second).toBe(first)
        expect(requestChatData).toHaveBeenCalledTimes(1)
        expect(vi.mocked(requestChatData).mock.calls[0][0].disableThinking).toBe(true)
    })

    test('falls back to the original prompt when English conversion fails', async () => {
        const char = makeCharacter()
        char.name = '메구미'
        char.visualManagerSettings = {
            enabled:true, autoAnalyze:false, maxCharacters:20, maxLocations:10, recentMessages:50, debug:true
        }
        vi.mocked(requestChatData).mockResolvedValue({ type:'fail', result:'translation unavailable' })

        await expect(prepareVisualImagePrompt('메구미가 서 있다.', char)).resolves.toBe('메구미가 서 있다.')

        expect(char.chats[0].visualMemory?.lastDebugStatus?.join(' ')).toContain('English prompt conversion failed')
    })

    test('leaves the prompt unchanged and retries failed analysis only after a message change', async () => {
        const char = makeCharacter()
        enableVisuals(char)
        vi.mocked(requestChatData).mockResolvedValue({ type:'fail', result:'model unavailable' })
        await expect(prepareVisualImagePrompt('plain scene', char)).resolves.toBe('plain scene')
        expect(requestChatData).toHaveBeenCalledTimes(1)
        expect(char.chats[0].visualMemory?.lastAnalyzedFingerprint).toBeUndefined()
        expect(char.chats[0].visualMemory?.lastFailedAnalysisFingerprint).toBeDefined()
        await expect(prepareVisualImagePrompt('plain scene', char)).resolves.toBe('plain scene')
        expect(requestChatData).toHaveBeenCalledTimes(1)

        char.chats[0].message.push({ role:'user', data:'Bob arrives.' })
        await expect(prepareVisualImagePrompt('plain scene', char)).resolves.toBe('plain scene')
        expect(requestChatData).toHaveBeenCalledTimes(2)
    })

    test('returns the original prompt without reading memory or requesting models when disabled', async () => {
        const char = makeCharacter()
        enableVisuals(char, { enabled:false })

        await expect(prepareVisualImagePrompt('unchanged scene', char)).resolves.toBe('unchanged scene')

        expect(requestChatData).not.toHaveBeenCalled()
        expect(getDatabase).not.toHaveBeenCalled()
    })

    test('does not inject the active character profile when that character is absent from the scene', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.visualManagerSettings = {
            enabled:true, autoAnalyze:false, maxCharacters:20, maxLocations:10, recentMessages:50, debug:true
        }
        const profile = createVisualCharacterProfile(char.chaId, 'Alice', 'asset')
        profile.style.artStyle = 'watercolor illustration'
        char.visualAssetProfiles = [profile]

        const prompt = await prepareVisualImagePrompt('An empty city street at dawn.', char)

        expect(prompt).not.toContain('watercolor illustration')
    })

    test('does not run automatic asset Vision analysis when autoAnalyze is disabled', async () => {
        const char = makeCharacter()
        char.name = 'Alice'
        char.image = 'assets/alice.png'
        char.visualManagerSettings = {
            enabled:true, autoAnalyze:false, maxCharacters:20, maxLocations:10, recentMessages:50, debug:false
        }

        await prepareVisualImagePrompt('Alice in a garden.', char)

        expect(readImage).not.toHaveBeenCalled()
        expect(requestChatData).not.toHaveBeenCalled()
    })

    test('applies the enabled default when a character has no Visual Manager settings', async () => {
        const char = makeCharacter()
        char.visualManagerSettings = undefined
        modelResponse({ characters:[], locations:[] })

        await prepareVisualImagePrompt('A scene.', char)

        expect(char.visualManagerSettings?.enabled).toBe(true)
        expect(requestChatData).toHaveBeenCalledTimes(1)
    })
})
