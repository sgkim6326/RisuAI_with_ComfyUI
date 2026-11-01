import { getDatabase, type Chat, type ChatVisualMemory, type character, type loreBook, type VisualCharacterProfile, type VisualLocationProfile, type VisualLoreClassification, type VisualStateChange } from "../storage/database.svelte"
import { requestChatData } from "./request/request"
import type { OpenAIChat } from "./index.svelte"
import { readImage } from "../globalApi.svelte"
import { getModelInfo, LLMFlags, ProviderNames } from "../model/modellist"
import { visualManagerInstructionTemplate } from "./visualPromptInstructions"
import { getInlayAsset } from "./files/inlays"
import type { ImgGenSceneSpec } from "./visualSceneSpec"
import { compileSceneSpecPrompt } from "./visualSceneSpec"

const defaultVisualSettings = {
    enabled: true,
    autoAnalyze: true,
    maxCharacters: 20,
    maxLocations: 10,
    recentMessages: 50,
    debug: false
}

function escapeRegExp(text:string):string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function translateScenePromptIfNeeded(prompt:string, char:character, memory:ChatVisualMemory, identifiers:string[]):Promise<string> {
    if(!containsNonEnglishScript(prompt)) return prompt
    const uniqueIdentifiers = [...new Set(identifiers.filter(Boolean))].sort((a, b) => b.length - a.length)
    const placeholders:Array<{token:string; value:string}> = []
    let protectedPrompt = prompt
    for(let index = 0; index < uniqueIdentifiers.length; index++) {
        const value = uniqueIdentifiers[index]
        if(!containsNonEnglishScript(value) && !/[A-Za-z0-9]/.test(value)) continue
        const token = `RISUENTITYTOKEN${index}X`
        const escaped = escapeRegExp(value)
        const pattern = /[A-Za-z]/.test(value) ? new RegExp(`(^|[^A-Za-z0-9])(${escaped})(?=$|[^A-Za-z0-9])`, 'gi') : new RegExp(escaped, 'g')
        protectedPrompt = protectedPrompt.replace(pattern, (...args:string[]) => {
            if(/[A-Za-z]/.test(value)) return `${args[1]}${token}`
            return token
        })
        if(protectedPrompt.includes(token)) placeholders.push({ token, value })
    }
    const sourceFingerprint = fingerprint(`${visualModelId()}\n${protectedPrompt}`)
    if(memory.englishPromptCache?.fingerprint === sourceFingerprint) return memory.englishPromptCache.prompt
    updateAnalysisMetrics(char, { llmCalls:1 })
    const response = await requestChatData({
        formated:[
            {
                role:'system',
                content:'Translate the supplied image prompt into natural English. Preserve the scene facts, actions, expressions, composition, and every RISUENTITYTOKEN exactly; do not add details. Return only the translated prompt.'
            },
            { role:'user', content:protectedPrompt }
        ],
        currentChar:char,
        temperature:0,
        maxTokens:900,
        bias:{},
        useStreaming:false,
        noMultiGen:true,
        blockPlugins:true,
        disableThinking:true
    }, 'submodel')
    if(response.type !== 'success') {
        throw new Error(typeof response.result === 'string' ? response.result : 'English prompt translation failed.')
    }
    let translated = response.result.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '').trim()
    translated = translated.replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, '').replace(/^["']|["']$/g, '')
    if(placeholders.some(({ token }) => !translated.includes(token))) {
        throw new Error('The translation omitted a protected character, location, or asset identifier.')
    }
    if(containsNonEnglishScript(translated)) throw new Error('The translation still contains non-English visual descriptions.')
    for(const { token, value } of placeholders) translated = translated.replaceAll(token, value)
    memory.englishPromptCache = { fingerprint:sourceFingerprint, prompt:translated }
    return translated
}

export { visualManagerInstructionTemplate }

export function getVisualSettings(char:character) {
    char.visualManagerSettings ??= { ...defaultVisualSettings }
    const settings = char.visualManagerSettings
    settings.enabled ??= defaultVisualSettings.enabled
    settings.autoAnalyze ??= defaultVisualSettings.autoAnalyze
    settings.debug ??= defaultVisualSettings.debug
    if(!Number.isFinite(settings.maxCharacters) || settings.maxCharacters < 0) settings.maxCharacters = defaultVisualSettings.maxCharacters
    if(!Number.isFinite(settings.maxLocations) || settings.maxLocations < 0) settings.maxLocations = defaultVisualSettings.maxLocations
    if(!Number.isFinite(settings.recentMessages) || settings.recentMessages < 1) settings.recentMessages = defaultVisualSettings.recentMessages
    settings.maxCharacters = Math.floor(settings.maxCharacters)
    settings.maxLocations = Math.floor(settings.maxLocations)
    settings.recentMessages = Math.floor(settings.recentMessages)
    return settings
}

export function createVisualCharacterProfile(id:string, name:string, source:'asset'|'memory' = 'memory'):VisualCharacterProfile {
    return {
        id,
        name,
        aliases: [],
        source,
        style: { medium:'', artStyle:'', lineArt:'', shading:'', colorPalette:'', additional:'' },
        face: { shape:'', features:'' },
        eye: { color:'', shape:'', details:'' },
        hair: { color:'', length:'', style:'', details:'' },
        body: { build:'', skin:'', proportions:'', distinctiveFeatures:'' },
        clothing: {
            presets: { casual: { name:'일상복', description:'' } },
            defaultPreset: 'casual'
        },
        manualFields: []
    }
}

export function createVisualLocationProfile(id:string, name:string, source:'lorebook'|'memory' = 'memory'):VisualLocationProfile {
    return {
        id,
        name,
        aliases: [],
        source,
        structure:'',
        interior:'',
        lighting:'',
        colorPalette:'',
        atmosphere:'',
        manualFields:[]
    }
}

export function getChatVisualMemory(chat:Chat):ChatVisualMemory {
    chat.visualMemory ??= {
        characters: [],
        locations: [],
        currentCharacterIds: [],
        currentLocationIds: [],
        currentOutfits: {}
    }
    chat.visualMemory.characters ??= []
    chat.visualMemory.locations ??= []
    chat.visualMemory.currentCharacterIds ??= []
    chat.visualMemory.currentLocationIds ??= []
    chat.visualMemory.currentOutfits ??= {}
    chat.visualMemory.baseOutfits ??= { ...chat.visualMemory.currentOutfits }
    chat.visualMemory.appearanceStates ??= {}
    chat.visualMemory.stateChanges ??= []
    chat.visualMemory.recentImages ??= []
    return chat.visualMemory
}

function updateAnalysisMetrics(char:character, update:Partial<NonNullable<ChatVisualMemory['lastAnalysisMetrics']>>):void {
    const chat = char.chats?.[char.chatPage]
    if(!chat) return
    const memory = getChatVisualMemory(chat)
    const current = memory.lastAnalysisMetrics ?? {
        elapsedMs:0,
        assetMetadataCount:0,
        imageBytesRead:0,
        visionCalls:0,
        llmCalls:0,
        cacheHits:0
    }
    memory.lastAnalysisMetrics = {
        elapsedMs:current.elapsedMs,
        assetMetadataCount:current.assetMetadataCount + (update.assetMetadataCount ?? 0),
        imageBytesRead:current.imageBytesRead + (update.imageBytesRead ?? 0),
        visionCalls:current.visionCalls + (update.visionCalls ?? 0),
        llmCalls:current.llmCalls + (update.llmCalls ?? 0),
        cacheHits:current.cacheHits + (update.cacheHits ?? 0)
    }
}

const activeVisualAnalyses = new WeakMap<Chat, Promise<void>>()
const activeVisualAssetAnalyses = new WeakMap<VisualCharacterProfile, Promise<void>>()
const activeInitialProfileExtractions = new WeakMap<Chat, Promise<void>>()

function normalizedName(value:string):string {
    return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function matchesName(text:string, name:string):boolean {
    if(/[A-Za-z]/.test(name)) {
        const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, 'i').test(text)
    }
    const needle = normalizedName(name)
    if(needle.length < 2) return false
    return normalizedName(text).includes(needle)
}

function profileMatches(profile:Pick<VisualCharacterProfile, 'name'|'aliases'>, name:string):boolean {
    const normalized = normalizedName(name)
    return [profile.name, ...profile.aliases].some(alias => normalizedName(alias) === normalized)
}

function locationMatches(profile:Pick<VisualLocationProfile, 'name'|'aliases'>, name:string):boolean {
    const normalized = normalizedName(name)
    return [profile.name, ...profile.aliases].some(alias => normalizedName(alias) === normalized)
}

function findUniqueProfile<T extends {name:string; aliases:string[]}>(
    profiles:T[],
    candidates:string[],
    matches:(profile:T, name:string) => boolean
):{profile?:T; ambiguous:boolean} {
    const found = profiles.filter(profile => candidates.some(name => matches(profile, name)))
    return found.length === 1 ? { profile:found[0], ambiguous:false } : { ambiguous:found.length > 1 }
}

function isUnambiguousPromptMatch<T extends {id:string; name:string; aliases:string[]}>(
    profile:T,
    catalog:T[],
    prompt:string,
    currentIds:string[]
):boolean {
    if(currentIds.includes(profile.id)) return true
    const mentions = [profile.name, ...profile.aliases].filter(name => matchesName(prompt, name))
    return mentions.some(name => catalog.filter(candidate =>
        [candidate.name, ...candidate.aliases].some(alias => normalizedName(alias) === normalizedName(name))
    ).length === 1)
}

function uniqueStrings(values:unknown):string[] {
    if(!Array.isArray(values)) return []
    return [...new Set(values.filter((value):value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()))]
}

export function updateManualVisualField<T extends {manualFields?:string[]}>(profile:T, path:string, value:string):void {
    const keys = path.split('.')
    let target:Record<string, unknown> = profile as Record<string, unknown>
    for(const key of keys.slice(0, -1)) {
        const next = target[key]
        if(!next || typeof next !== 'object') return
        target = next as Record<string, unknown>
    }
    target[keys.at(-1)!] = value
    profile.manualFields ??= []
    if(!profile.manualFields.includes(path)) profile.manualFields.push(path)
}

function getAssetProfiles(char:character, assets = getVisualCharacterAssets(char)):VisualCharacterProfile[] {
    const overrides = char.visualAssetProfiles ?? []
    const savedMain = overrides.find(profile => profile.id === char.chaId)
    const mainProfile = savedMain
        ? savedMain
        : createVisualCharacterProfile(char.chaId, char.name, 'asset')
    mainProfile.source = 'asset'
    mainProfile.name ||= char.name
    if(!mainProfile.manualFields?.includes('aliases')) {
        mainProfile.aliases = uniqueStrings([
            ...mainProfile.aliases,
            char.nickname ?? ''
        ]).filter(alias => normalizedName(alias) !== normalizedName(mainProfile.name))
    }
    const mainAsset = findAssociatedCharacterAsset(char, mainProfile, assets)
    if(mainAsset) {
        mainProfile.assetUri ??= mainAsset.uri
        mainProfile.assetName ??= mainAsset.name
        mainProfile.assetKind ??= mainAsset.kind
    }
    const linkedProfiles = overrides.filter(profile => profile.id !== char.chaId)
    for(const profile of linkedProfiles) profile.source = 'asset'
    return [mainProfile, ...linkedProfiles]
}

interface VisualAssetCatalogCache {
    image?:string
    name:string
    nickname?:string
    ccAssets:character['ccAssets']
    ccAssetsLength:number
    additionalAssets:character['additionalAssets']
    additionalAssetsLength:number
    emotionImages:character['emotionImages']
    emotionImagesLength:number
    revision:number
    assets:CharacterImageAsset[]
    builds:number
    entriesVisited:number
}

const visualAssetCatalogCache = new WeakMap<character, VisualAssetCatalogCache>()

export function getVisualAssetCatalogStats(char:character):{builds:number; entriesVisited:number} {
    const cache = visualAssetCatalogCache.get(char)
    return { builds:cache?.builds ?? 0, entriesVisited:cache?.entriesVisited ?? 0 }
}

function getVisualAssetCatalogVisitDelta(char:character, previous:number):number {
    return Math.max(0, getVisualAssetCatalogStats(char).entriesVisited - previous)
}

export interface CharacterImageAsset {
    uri:string
    name:string
    extension:string
    kind:'portrait'|'charx'|'additional'|'emotion'|'linked'
}

export function getVisualCharacterAssets(char:character):CharacterImageAsset[] {
    const cached = visualAssetCatalogCache.get(char)
    if(cached &&
        cached.image === char.image &&
        cached.name === char.name &&
        cached.nickname === char.nickname &&
        cached.ccAssets === char.ccAssets && cached.ccAssetsLength === (char.ccAssets?.length ?? 0) &&
        cached.additionalAssets === char.additionalAssets && cached.additionalAssetsLength === (char.additionalAssets?.length ?? 0) &&
        cached.emotionImages === char.emotionImages && cached.emotionImagesLength === (char.emotionImages?.length ?? 0) &&
        cached.revision === (char.visualAssetCatalogRevision ?? 0)
    ) return cached.assets

    const assets:CharacterImageAsset[] = []
    if(char.image) assets.push({ uri:char.image, name:char.name, extension:'png', kind:'portrait' })
    for(const asset of char.ccAssets ?? []) {
        if(!asset.uri) continue
        assets.push({ uri:asset.uri, name:asset.name || asset.type, extension:asset.ext, kind:'charx' })
    }
    for(const [name, uri, extension] of char.additionalAssets ?? []) {
        if(!uri) continue
        assets.push({ uri, name:name || extension, extension, kind:'additional' })
    }
    for(const [name, uri] of char.emotionImages ?? []) {
        if(!uri) continue
        assets.push({ uri, name, extension:'png', kind:'emotion' })
    }
    visualAssetCatalogCache.set(char, {
        image:char.image,
        name:char.name,
        nickname:char.nickname,
        ccAssets:char.ccAssets,
        ccAssetsLength:char.ccAssets?.length ?? 0,
        additionalAssets:char.additionalAssets,
        additionalAssetsLength:char.additionalAssets?.length ?? 0,
        emotionImages:char.emotionImages,
        emotionImagesLength:char.emotionImages?.length ?? 0,
        revision:char.visualAssetCatalogRevision ?? 0,
        assets,
        builds:(cached?.builds ?? 0) + 1,
        entriesVisited:(cached?.entriesVisited ?? 0) +
            (char.image ? 1 : 0) +
            (char.ccAssets?.length ?? 0) +
            (char.additionalAssets?.length ?? 0) +
            (char.emotionImages?.length ?? 0)
    })
    return assets
}

export function resolveChatAssetReferences(chat:Chat, char:character, assets = getVisualCharacterAssets(char)):CharacterImageAsset[] {
    const references = new Set<string>()
    for(const message of chat.message.slice(-100)) {
        for(const match of message.data.matchAll(/{{(asset|emotion)::(.+?)}}/gi)) {
            references.add(normalizedName(match[2]))
        }
    }
    return assets.filter(asset => references.has(normalizedName(asset.name)))
}

function linkUnambiguousNamedAssets(char:character, values:unknown[], assets = getVisualCharacterAssets(char)):void {
    char.visualAssetProfiles ??= []
    for(const value of values) {
        const item = asRecord(value)
        const name = readText(item.name)
        if(!name) continue
        const candidates = assets.filter(asset => matchesName(asset.name, name))
        if(candidates.length !== 1) continue
        const asset = candidates[0]
        if(char.visualAssetProfiles.some(profile => profile.assetUri === asset.uri || profileMatches(profile, name))) continue
        const profile = createVisualCharacterProfile(`visual-asset-${fingerprint(asset.uri)}`, name, 'asset')
        profile.assetUri = asset.uri
        profile.assetName = asset.name
        profile.assetKind = asset.kind
        char.visualAssetProfiles.push(profile)
    }
}

function findAssociatedCharacterAsset(char:character, profile:VisualCharacterProfile, assets = getVisualCharacterAssets(char)):CharacterImageAsset|undefined {
    if(profile.assetUri) {
        return assets.find(asset => asset.uri === profile.assetUri)
            ?? { uri:profile.assetUri, name:profile.assetName ?? profile.name, extension:'png', kind:profile.assetKind ?? 'linked' }
    }
    const aliases = [profile.name, ...profile.aliases].filter(alias => normalizedName(alias).length >= 3)
    const candidates = assets.filter(asset =>
        aliases.some(alias => matchesName(asset.name, alias))
    )
    return candidates.length === 1 ? candidates[0] : undefined
}

function sourceVisualDescription(source:string):string {
    const relevant = source.split(/[\n.!?。！？]+/)
        .map(sentence => sentence.trim())
        .filter(sentence => /(?:hair|haired|eyes|eyed|face|skin|wearing|outfit|clothing|appearance|portrait|haircut|height|build|髪|目|瞳|顔|肌|服装|衣装|外見|身長|体格|머리|눈|얼굴|피부|옷|외모|키|체격)/i.test(sentence))
    return relevant.slice(0, 4).join('. ').slice(0, 500)
}

function visualModelId():string {
    const db = getDatabase()
    return db.subModel
}

function analysisModelDetails(modelId = visualModelId()):{id:string; provider:string} {
    const model = getModelInfo(modelId)
    return { id:modelId, provider:ProviderNames.get(model.provider) ?? String(model.provider) }
}

function imageMimeType(image:Uint8Array):string|undefined {
    if(image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47) return 'image/png'
    if(image[0] === 0xff && image[1] === 0xd8) return 'image/jpeg'
    if(image[0] === 0x52 && image[1] === 0x49 && image[8] === 0x57 && image[9] === 0x45) return 'image/webp'
    if(image[0] === 0x47 && image[1] === 0x49 && image[2] === 0x46) return 'image/gif'
    if(image[0] === 0x42 && image[1] === 0x4d) return 'image/bmp'
    return undefined
}

function isSupportedImageExtension(extension:string):boolean {
    switch(extension.toLowerCase().replace(/^\./, '')) {
        case 'jpg':
        case 'jpeg':
        case 'webp':
        case 'gif':
        case 'bmp':
        case 'png':
            return true
        default:
            return false
    }
}

export function analyzeVisualAssetIfNeeded(char:character, profile:VisualCharacterProfile, force = false, linkedAsset?:CharacterImageAsset):Promise<void> {
    const active = activeVisualAssetAnalyses.get(profile)
    if(active && !force) return active
    const task = analyzeVisualAssetOnce(char, profile, force, linkedAsset).finally(() => {
        activeVisualAssetAnalyses.delete(profile)
    })
    activeVisualAssetAnalyses.set(profile, task)
    return task
}

async function analyzeVisualAssetOnce(char:character, profile:VisualCharacterProfile, force = false, linkedAsset?:CharacterImageAsset):Promise<void> {
    const asset = linkedAsset ?? findAssociatedCharacterAsset(char, profile)
    if(!asset) return
    const modelId = visualModelId()
    if(!force && profile.assetUri === asset.uri && profile.visionModel === modelId && profile.visionAnalysisStatus) {
        updateAnalysisMetrics(char, { cacheHits:1 })
        return
    }
    profile.assetUri = asset.uri
    profile.assetName = asset.name
    profile.assetKind = asset.kind
    try {
        const image = await readImage(asset.uri)
        if(!(image instanceof Uint8Array) || image.length === 0) throw new Error('The linked character image could not be read.')
        updateAnalysisMetrics(char, { imageBytesRead:image.length })
        if(image.length > 15 * 1024 * 1024) throw new Error('The linked image exceeds the 15 MiB Visual Manager analysis limit.')
        const contentHash = await hashImage(image)
        if(!force && profile.visionModel === modelId && profile.assetContentHash === contentHash &&
            (profile.visionAnalysisStatus === 'complete' || profile.visionAnalysisStatus === 'unavailable' || profile.visionAnalysisStatus === 'failed')) return
        profile.visionModel = modelId
        profile.assetContentHash = contentHash
        profile.visionFailure = undefined
        const model = getModelInfo(modelId)
        if(!model.flags.includes(LLMFlags.hasImageInput)) {
            profile.visionAnalysisStatus = 'unavailable'
            profile.visionFailure = `Selected submodel "${modelId}" does not support image input.`
            persistAssetProfile(char, profile)
            return
        }
        const mimeType = imageMimeType(image)
        if(!mimeType || (asset.extension && asset.extension !== 'unknown' && !isSupportedImageExtension(asset.extension))) {
            throw new Error('The linked CHARX asset is not a supported raster image.')
        }
        const imageData = `data:${mimeType};base64,${Buffer.from(image).toString('base64')}`
        const formated:OpenAIChat[] = [
            {
                role:'system',
                content:'Analyze the supplied character image for a visual reference profile. Return JSON with style {medium, artStyle, lineArt, shading, colorPalette, additional}, face {shape, features}, eye {color, shape, details}, hair {color, length, style, details}, body {build, skin, proportions, distinctiveFeatures}, and clothing {presets:{casual:{name,description}}, defaultPreset}. Write every visual description value in natural English, regardless of the language of the request. Preserve identifiers only; do not translate a person or asset name. Only report visible traits; do not infer hidden traits, identity, personality, or details not visible in the image. Keep unknown fields empty. Describe visual medium and rendering style separately from appearance. JSON only.'
            },
            {
                role:'user',
                content:`Create a reusable visual profile for "${profile.name}" from the linked CHARX asset "${asset.name}".`,
                multimodals:[{type:'image', base64:imageData}]
            }
        ]
        updateAnalysisMetrics(char, { visionCalls:1, llmCalls:1 })
        const response = await requestChatData({
            formated,
            currentChar:char,
            temperature:0.1,
            maxTokens:900,
            bias:{},
            useStreaming:false,
            noMultiGen:true,
            blockPlugins:true,
            disableThinking:true
        }, 'submodel')
        if(response.type !== 'success') {
            const reason = typeof response.result === 'string' ? response.result : 'The configured Vision model returned an unexpected response.'
            throw new Error(reason || 'The configured Vision model returned no profile.')
        }
        const result = await translateVisualFieldsIfNeeded(parseModelJson(response.result), char)
        const manual = new Set(profile.manualFields ?? [])
        mergeMissing(profile as unknown as Record<string, unknown>, {
            style:asRecord(result.style),
            face:asRecord(result.face),
            eye:asRecord(result.eye),
            hair:asRecord(result.hair),
            body:asRecord(result.body),
            clothing:asRecord(result.clothing)
        }, '', manual)
        profile.visionAnalysisStatus = 'complete'
        profile.visionFailure = undefined
        persistAssetProfile(char, profile)
    } catch(error) {
        profile.visionAnalysisStatus = 'failed'
        profile.visionFailure = error instanceof Error ? error.message : String(error)
        persistAssetProfile(char, profile)
        console.warn(`Visual Manager could not analyze the linked image for ${profile.name}; image generation will continue.`, error)
    }
}

function persistAssetProfile(char:character, profile:VisualCharacterProfile):void {
    char.visualAssetProfiles ??= []
    const existing = char.visualAssetProfiles.findIndex(item => item.id === profile.id)
    if(existing < 0) char.visualAssetProfiles.push(profile)
    else char.visualAssetProfiles[existing] = profile
}

export async function analyzeReferencedVisualAssets(char:character, chat:Chat, assetCatalog = getVisualCharacterAssets(char)):Promise<void> {
    const settings = getVisualSettings(char)
    if(!settings.enabled || !settings.autoAnalyze) return
    const references = resolveChatAssetReferences(chat, char, assetCatalog)
    if(references.length === 0) return
    const profiles = getAssetProfiles(char, assetCatalog)
    const memory = getChatVisualMemory(chat)
    for(const asset of references) {
        const linkedProfiles = profiles.filter(profile =>
            profile.assetUri === asset.uri ||
            (profile.id === char.chaId && (asset.kind === 'portrait' || asset.kind === 'emotion')) ||
            [profile.name, ...profile.aliases].some(alias => normalizedName(alias) === normalizedName(asset.name))
        )
        if(linkedProfiles.length !== 1) {
            memory.lastDebugStatus ??= []
            memory.lastDebugStatus.push(`Asset ${asset.name} skipped: ownership is ambiguous or unlinked.`)
            continue
        }
        const [profile] = linkedProfiles
        profile.assetUri = asset.uri
        profile.assetName = asset.name
        profile.assetKind = asset.kind
        await analyzeVisualAssetIfNeeded(char, profile, false, asset)
    }
}

export async function analyzeVisualResponse(char:character, chat:Chat):Promise<void> {
    const startedAt = Date.now()
    try {
        const settings = getVisualSettings(char)
        if(!settings.enabled || !settings.autoAnalyze) return
        const catalogVisitsBefore = getVisualAssetCatalogStats(char).entriesVisited
        const assets = getVisualCharacterAssets(char)
        const memory = getChatVisualMemory(chat)
        memory.lastAnalysisSource = 'chat-response'
        memory.lastAnalysisMetrics = {
            elapsedMs:0,
            assetMetadataCount:getVisualAssetCatalogVisitDelta(char, catalogVisitsBefore),
            imageBytesRead:0,
            visionCalls:0,
            llmCalls:0,
            cacheHits:0
        }
        await analyzeVisualMemory(char, chat, assets)
        await analyzeReferencedVisualAssets(char, chat, assets)
        memory.lastSavedAt = Date.now()
        if(memory.lastAnalysisMetrics) memory.lastAnalysisMetrics.elapsedMs = Date.now() - startedAt
    } catch(error) {
        console.warn('Visual Manager response update failed; chat completion will continue.', error)
        const memory = getChatVisualMemory(chat)
        memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), `Response update failed: ${error instanceof Error ? error.message : String(error)}`]
    }
}

export function getVisualLorebookCatalog(char:character, chat:Chat):VisualLocationProfile[] {
    const overrides = char.visualAssetLocations ?? []
    const db = getDatabase()
    const lorebooks = getLorebookEntries(char, chat)
    const seen = new Set<string>()
    return lorebooks.flatMap(({entry, scope}, index) => {
        if(entry.mode === 'folder') return []
        const id = `${scope}:${entry.id ?? `${entry.comment || entry.key}-${index}`}`
        if(seen.has(id)) return []
        seen.add(id)
        const sourceFingerprint = fingerprint([entry.key, entry.secondkey, entry.comment, entry.content, entry.mode, entry.folder].join('\n'))
        char.visualLoreClassificationCache ??= {}
        let cached = char.visualLoreClassificationCache[id]
        if(!cached || cached.fingerprint !== sourceFingerprint) {
            cached = { fingerprint:sourceFingerprint, classification:classifyLorebookEntry(entry) }
            char.visualLoreClassificationCache[id] = cached
        }
        const saved = overrides.find(profile => profile.id === id)
        if(!saved && cached.classification !== 'place') return []
        const profile = saved
            ? { ...saved, aliases:[...saved.aliases] }
            : createVisualLocationProfile(id, entry.comment || entry.key || `Location ${index + 1}`, 'lorebook')
        profile.source = 'lorebook'
        profile.classification = saved ? 'place' : cached.classification
        profile.sourceFingerprint = sourceFingerprint
        if(cached.profile) {
            profile.structure ||= cached.profile.structure
            profile.interior ||= cached.profile.interior
            profile.lighting ||= cached.profile.lighting
            profile.colorPalette ||= cached.profile.colorPalette
            profile.atmosphere ||= cached.profile.atmosphere
        }
        profile.aliases = uniqueStrings([...profile.aliases, entry.key, entry.secondkey])
        return [profile]
    })
}

function getLorebookEntries(char:character, chat:Chat):{entry:loreBook; scope:string}[] {
    const db = getDatabase()
    return [
        ...(char.globalLore ?? []).map(entry => ({ entry, scope:`character:${char.chaId}` })),
        ...(chat.localLore ?? []).map(entry => ({ entry, scope:`chat:${chat.id ?? chat.name}` })),
        ...(db.loreBook ?? []).flatMap(book => (book.data ?? []).map(entry => ({ entry, scope:`global:${book.name}` })))
    ]
}

function classifyLorebookEntry(entry:loreBook):VisualLoreClassification {
    const name = `${entry.comment} ${entry.key} ${entry.secondkey}`.toLocaleLowerCase()
    const content = entry.content.toLocaleLowerCase()
    const allText = `${name}\n${content}`
    if(/(?:메인\s*캐릭터|퍼메\s*캐릭터|캐릭터|인물|character|persona|person|npc|프로필|profile|능동성|수동성|성격|외형|인격|관계|말투|호칭)/i.test(name)) return 'person'
    if(/(?:event|incident|사건|이벤트|전투|기억|과거|history)/i.test(name)) return 'event'
    if(/(?:rule|규칙|금지|조건|원칙|법칙|설정|worldbuilding|세계관)/i.test(name)) return 'rule'
    if(/(?:worldbuilding|세계관|역사|종족|마법|시스템|규칙)/i.test(content) && !/(?:location|place|장소|지역|도시|마을|방|집|학교|궁전|숲|건물)/i.test(name)) return 'worldbuilding'
    if(/(?:location|place|setting|city|town|village|room|house|home|school|library|palace|castle|forest|street|cafe|café|building|temple|station|landscape|장소|지역|도시|마을|공간|방|집|학교|도서관|궁전|성|숲|거리|카페|건물|사원|역|해변|산|마당)/i.test(name)) return 'place'
    if(/(?:main character|character sheet|메인 캐릭터|퍼메 캐릭터|\[.*캐릭터.*\])/i.test(allText.slice(0, 300))) return 'person'
    return 'unknown'
}

async function classifyRelevantLorebookLocations(char:character, chat:Chat, prompt:string):Promise<void> {
    const candidates = getLorebookEntries(char, chat).flatMap(({entry, scope}, index) => {
        if(entry.mode === 'folder') return []
        const id = `${scope}:${entry.id ?? `${entry.comment || entry.key}-${index}`}`
        const sourceFingerprint = fingerprint([entry.key, entry.secondkey, entry.comment, entry.content, entry.mode, entry.folder].join('\n'))
        char.visualLoreClassificationCache ??= {}
        let cached = char.visualLoreClassificationCache[id]
        if(cached?.fingerprint !== sourceFingerprint) {
            cached = { fingerprint:sourceFingerprint, classification:classifyLorebookEntry(entry) }
            char.visualLoreClassificationCache[id] = cached
        }
        const name = entry.comment || entry.key || entry.secondkey
        const isRelevant = [entry.comment, entry.key, entry.secondkey].some(value => value && matchesName(prompt, value))
        const needsClassification = cached.classification === 'unknown'
        const needsPlaceProfile = cached.classification === 'place' && !cached.profile
        if((!needsClassification && !needsPlaceProfile) || cached.attempted || !name || !isRelevant) return []
        return [{
            id,
            name,
            key:entry.key,
            secondkey:entry.secondkey,
            content:entry.content.slice(0, 4000),
            classification:cached.classification,
            sourceFingerprint
        }]
    })
    if(candidates.length === 0) return
    try {
        updateAnalysisMetrics(char, { llmCalls:1 })
        const response = await requestChatData({
            formated:[
                {
                    role:'system',
                    content:'Classify candidates marked unknown as place, person, event, rule, worldbuilding, or unknown. Candidates already marked place are confirmed physical settings; extract only established structure, interior, lighting, colorPalette, and atmosphere from those entries. A place is a physical, spatial setting, not a character profile, event, instruction, lore rule, or general world fact. Write all visual descriptions in natural English; preserve names and identifiers. Do not infer missing details. Return JSON only as {"entries":[{"id":"...","classification":"...","profile":{...}}]}.'
                },
                { role:'user', content:JSON.stringify(candidates) }
            ],
            currentChar:char,
            temperature:0,
            maxTokens:1000,
            bias:{},
            useStreaming:false,
            noMultiGen:true,
            blockPlugins:true,
            disableThinking:true
        }, 'submodel')
        if(response.type !== 'success') {
            throw new Error(typeof response.result === 'string' ? response.result : 'Lorebook classification failed.')
        }
        const result = await translateVisualFieldsIfNeeded(parseModelJson(response.result), char)
        if(!Array.isArray(result.entries)) throw new Error('Lorebook classification returned no entries.')
        const returnedIds = new Set<string>()
        for(const value of result.entries) {
            const item = asRecord(value)
            const candidate = candidates.find(entry => entry.id === readText(item.id))
            if(!candidate) continue
            returnedIds.add(candidate.id)
            const returnedClassification = ['place','person','event','rule','worldbuilding','unknown'].includes(readText(item.classification))
                ? readText(item.classification) as VisualLoreClassification : 'unknown'
            const accepted = candidate.classification === 'place' ? 'place' : returnedClassification
            const profile = asRecord(item.profile)
            char.visualLoreClassificationCache[candidate.id] = {
                fingerprint:candidate.sourceFingerprint,
                classification:accepted,
                attempted:true,
                profile:accepted === 'place' ? {
                    structure:readText(profile.structure),
                    interior:readText(profile.interior),
                    lighting:readText(profile.lighting),
                    colorPalette:readText(profile.colorPalette),
                    atmosphere:readText(profile.atmosphere)
                } : undefined
            }
        }
        for(const candidate of candidates) {
            if(returnedIds.has(candidate.id)) continue
            char.visualLoreClassificationCache[candidate.id] = {
                fingerprint:candidate.sourceFingerprint,
                classification:candidate.classification,
                attempted:true,
                profile:candidate.classification === 'place'
                    ? { structure:'', interior:'', lighting:'', colorPalette:'', atmosphere:'' }
                    : undefined
            }
        }
    } catch(error) {
        console.warn('Visual Manager could not classify relevant lorebook entries; unclassified entries will be omitted.', error)
        const memory = getChatVisualMemory(chat)
        memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), `Lorebook classification failed: ${error instanceof Error ? error.message : String(error)}`]
        for(const candidate of candidates) {
            char.visualLoreClassificationCache[candidate.id] = {
                fingerprint:candidate.sourceFingerprint,
                classification:candidate.classification,
                attempted:true,
                profile:candidate.classification === 'place'
                    ? { structure:'', interior:'', lighting:'', colorPalette:'', atmosphere:'' }
                    : undefined
            }
        }
    }
}

function fingerprint(text:string):string {
    let hash = 2166136261
    for(let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16)
}

function asRecord(value:unknown):Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readText(value:unknown):string {
    return typeof value === 'string' ? value.trim() : ''
}

function mergeMissing(target:Record<string, unknown>, source:Record<string, unknown>, prefix:string, manual:Set<string>):void {
    for(const [key, value] of Object.entries(source)) {
        const path = prefix ? `${prefix}.${key}` : key
        if(manual.has(path)) continue
        if(value && typeof value === 'object' && !Array.isArray(value)) {
            const existing = target[key]
            if(existing && typeof existing === 'object' && !Array.isArray(existing)) {
                mergeMissing(existing as Record<string, unknown>, value as Record<string, unknown>, path, manual)
            }
            continue
        }
        if(typeof value === 'string' && value.trim() && (typeof target[key] !== 'string' || !(target[key] as string).trim())) {
            target[key] = value.trim()
        }
    }
}

function parseModelJson(text:string):Record<string, unknown> {
    const trimmed = text.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if(start < 0 || end <= start) throw new Error('Visual analysis did not return a JSON object')
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
}

function containsNonEnglishScript(text:string):boolean {
    return /[\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u0d7f\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af]/u.test(text)
}

function hasNonEnglishVisualFields(value:unknown, key = ''):boolean {
    if(typeof value === 'string') {
        return !['name', 'aliases', 'id', 'character', 'renamedFrom', 'previousNames', 'sourceMessageId', 'defaultPreset', 'key', 'secondkey'].includes(key) && containsNonEnglishScript(value)
    }
    if(Array.isArray(value)) return value.some(item => hasNonEnglishVisualFields(item, key))
    if(value && typeof value === 'object') {
        return Object.entries(value).some(([childKey, child]) => hasNonEnglishVisualFields(child, childKey))
    }
    return false
}

function restoreVisualIdentifiers(original:unknown, translated:unknown, key = ''):unknown {
    if(['name', 'aliases', 'id', 'character', 'renamedFrom', 'previousNames', 'sourceMessageId', 'defaultPreset', 'key', 'secondkey'].includes(key)) return original
    if(Array.isArray(original) && Array.isArray(translated)) {
        return original.map((item, index) => restoreVisualIdentifiers(item, translated[index], key))
    }
    if(original && translated && typeof original === 'object' && typeof translated === 'object') {
        const output:Record<string, unknown> = { ...(translated as Record<string, unknown>) }
        for(const [childKey, value] of Object.entries(original as Record<string, unknown>)) {
            output[childKey] = restoreVisualIdentifiers(value, output[childKey], childKey)
        }
        return output
    }
    return translated
}

function removeNonEnglishVisualFields(value:unknown, key = ''):unknown {
    if(typeof value === 'string') {
        return !['name', 'aliases', 'id', 'defaultPreset', 'key', 'secondkey', 'renamedFrom', 'previousNames'].includes(key) && containsNonEnglishScript(value)
            ? ''
            : value
    }
    if(Array.isArray(value)) return value.map(item => removeNonEnglishVisualFields(item, key))
    if(value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
            [childKey, removeNonEnglishVisualFields(child, childKey)]
        ))
    }
    return value
}

async function translateVisualFieldsIfNeeded(value:Record<string, unknown>, char:character):Promise<Record<string, unknown>> {
    if(!hasNonEnglishVisualFields(value)) return value
    const modelDetails = analysisModelDetails()
    updateAnalysisMetrics(char, { llmCalls:1 })
    try {
        const response = await requestChatData({
            formated:[
                {
                    role:'system',
                    content:'Translate only visual-description values in the supplied JSON into natural English. Preserve the exact JSON structure, keys, IDs, person names, aliases, renamedFrom, previousNames, preset names, and all non-description identifiers. Do not add, remove, or infer visual facts. Return JSON only.'
                },
                { role:'user', content:JSON.stringify(value) }
            ],
            currentChar:char,
            temperature:0,
            maxTokens:1200,
            bias:{},
            useStreaming:false,
            noMultiGen:true,
            blockPlugins:true,
            disableThinking:true
        }, 'submodel')
        if(response.type !== 'success') throw new Error(`English visual profile conversion failed: ${response.result}`)
        const translated = restoreVisualIdentifiers(value, parseModelJson(response.result)) as Record<string, unknown>
        if(hasNonEnglishVisualFields(translated)) throw new Error('English visual profile conversion returned non-English descriptions.')
        const chat = char.chats?.[char.chatPage]
        if(chat) {
            const memory = getChatVisualMemory(chat)
            const actualModel = response.model ?? modelDetails.id
            const actualDetails = analysisModelDetails(actualModel)
            memory.lastVisualTranslationModel = actualModel
            memory.lastVisualTranslationProvider = actualDetails.provider
        }
        return translated
    } catch(error) {
        const chat = char.chats?.[char.chatPage]
        if(chat) {
            const memory = getChatVisualMemory(chat)
            memory.lastVisualTranslationModel = modelDetails.id
            memory.lastVisualTranslationProvider = modelDetails.provider
            const reason = error instanceof Error ? error.message : String(error)
            memory.lastVisualTranslationFailureKind = isProviderContentBlock(reason)
                ? 'provider-content-block'
                : 'visual-language-conversion'
            memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), `Visual-language conversion was incomplete (${memory.lastVisualTranslationFailureKind}); non-English visual fields were omitted while names and valid fields were retained: ${reason}`]
        }
        console.warn('Visual Manager omitted visual-description fields that could not be safely converted to English.', error)
        return removeNonEnglishVisualFields(value) as Record<string, unknown>
    }
}

async function hashImage(image:Uint8Array):Promise<string> {
    if(globalThis.crypto?.subtle) {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(image).buffer as ArrayBuffer)
        return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
    }
    let hash = 2166136261
    for(const byte of image) {
        hash ^= byte
        hash = Math.imul(hash, 16777619)
    }
    return `fnv-${(hash >>> 0).toString(16)}-${image.length}`
}

function score(entry:{importance?:number; mentionCount?:number; lastSeenMessage?:number}, messageIndex:number):number {
    const age = Math.max(0, messageIndex - (entry.lastSeenMessage ?? 0))
    return (entry.importance ?? 0) * 3 + Math.min(entry.mentionCount ?? 0, 30) + Math.max(0, 20 - age / 10)
}

function visualEntityCandidates(source:string):string[] {
    const candidates = new Set<string>()
    const commonSentenceStarts = new Set(['A','An','And','As','At','After','Before','But','By','For','He','Her','I','In','It','Meanwhile','My','She','So','The','Then','They','This','To','We','When','While','With','You','User','Assistant'])
    for(const match of source.matchAll(/\b([A-Z][a-z]{2,}(?:[\s'-]+[A-Z][a-z]{2,})*)\b/g)) {
        const name = match[1].trim()
        if(!commonSentenceStarts.has(name)) candidates.add(name)
    }
    for(const match of source.matchAll(/\b(?:the|a|an)\s+((?:[a-z][a-z'-]*\s+){0,2}(?:room|library|house|home|school|city|town|village|palace|castle|forest|street|cafe|building|temple|station|beach|garden|office|hall|park|inn))\b/gi)) {
        candidates.add(match[1].trim())
    }
    const commonKoreanWords = new Set(['오늘','지금','어제','내일','이때','저녁','아침','한편','갑자기','아무','모든','그때','당신'])
    for(const match of source.matchAll(/([\uac00-\ud7af]{2,}?)(?:에게|에서|으로|은|는|이|가|을|를|의|와|과|도|에|로|랑)(?![\uac00-\ud7af])/g)) {
        const name = match[1].trim()
        if(name && !commonKoreanWords.has(name)) candidates.add(name)
    }
    return [...candidates]
}

function isUnresolvedVisualCandidate(
    name:string,
    characters:VisualCharacterProfile[],
    locations:VisualLocationProfile[]
):boolean {
    const characterMatches = characters.filter(profile => profileMatches(profile, name)).length
    const locationMatchCount = locations.filter(profile => locationMatches(profile, name)).length
    return characterMatches + locationMatchCount !== 1
}

function updateLocalVisualScene(
    source:string,
    memory:ChatVisualMemory,
    characters:VisualCharacterProfile[],
    locations:VisualLocationProfile[]
):void {
    for(const profile of memory.characters) profile.currentScene = false
    for(const profile of memory.locations) profile.currentScene = false
    const currentCharacters = characters.filter(profile =>
        [profile.name, ...profile.aliases].some(name => matchesName(source, name))
    )
    const currentLocations = locations.filter(profile =>
        [profile.name, ...profile.aliases].some(name => matchesName(source, name))
    )
    for(const profile of memory.characters) {
        if(currentCharacters.some(current => current.id === profile.id)) profile.currentScene = true
    }
    for(const profile of memory.locations) {
        if(currentLocations.some(current => current.id === profile.id)) profile.currentScene = true
    }
    memory.currentCharacterIds = [...new Set(currentCharacters.map(profile => profile.id))]
    memory.currentLocationIds = [...new Set(currentLocations.map(profile => profile.id))]
}

function backfillUnambiguousImageCharacterLinks(
    memory:ChatVisualMemory,
    chat:Chat,
    profiles:VisualCharacterProfile[]
):void {
    for(const image of memory.recentImages ?? []) {
        if(image.characterIds.length > 0) continue
        const linkedMessage = image.messageId
            ? chat.message.find((message, index) => visualMessageId(message, index) === image.messageId)
            : undefined
        const searchText = `${image.prompt}\n${linkedMessage?.data ?? ''}`
        const matches = profiles.filter(profile =>
            [profile.name, ...profile.aliases].some(alias => matchesName(searchText, alias))
        )
        const uniqueMatches = [...new Map(matches.map(profile => [profile.id, profile])).values()]
        if(uniqueMatches.length === 1) image.characterIds = [uniqueMatches[0].id]
    }
}

function visualMessageId(message:Chat['message'][number], index:number):string {
    return message.chatId ?? `message-${message.time ?? index}-${fingerprint(`${message.role}:${message.data}`)}`
}

function rebuildChatVisualState(memory:ChatVisualMemory, chat:Chat):void {
    const currentMessageIds = new Set(chat.message.map(visualMessageId))
    memory.stateChanges = (memory.stateChanges ?? []).filter(change => currentMessageIds.has(change.messageId))
    memory.appearanceStates = {}
    memory.currentOutfits = { ...(memory.baseOutfits ?? {}) }
    const messageOrder = new Map(chat.message.map((message, index) => [visualMessageId(message, index), index]))
    for(const change of [...memory.stateChanges].sort((a, b) =>
        (messageOrder.get(a.messageId) ?? -1) - (messageOrder.get(b.messageId) ?? -1)
    )) {
        if(change.field === 'clothing.current') {
            if(change.reverted || !change.value) delete memory.currentOutfits[change.characterId]
            else memory.currentOutfits[change.characterId] = change.value
            continue
        }
        memory.appearanceStates[change.characterId] ??= {}
        if(change.reverted || !change.value) delete memory.appearanceStates[change.characterId][change.field]
        else memory.appearanceStates[change.characterId][change.field] = change.value
    }
}

function recordVisualStateChange(
    memory:ChatVisualMemory,
    profileId:string,
    messageId:string,
    field:string,
    value:string,
    reverted = false
):void {
    const existing = memory.stateChanges?.findIndex(change =>
        change.characterId === profileId && change.messageId === messageId && change.field === field
    ) ?? -1
    const change:VisualStateChange = { characterId:profileId, messageId, field, value, reverted }
    if(existing >= 0) memory.stateChanges![existing] = change
    else (memory.stateChanges ??= []).push(change)
}

function resolveCharacterProfileId(
    value:string,
    profiles:VisualCharacterProfile[]
):string|undefined {
    const match = findUniqueProfile<VisualCharacterProfile>(profiles, [value], profileMatches)
    return match.ambiguous ? undefined : match.profile?.id
}

function applyAppearanceStateChanges(
    result:Record<string, unknown>,
    messageIds:string[],
    memory:ChatVisualMemory,
    profiles:VisualCharacterProfile[]
):void {
    const validMessageIds = new Set(messageIds)
    const allowedFields = new Set([
        'face.shape','face.features',
        'eye.color','eye.shape','eye.details',
        'hair.color','hair.length','hair.style','hair.details',
        'body.build','body.skin','body.proportions','body.distinctiveFeatures'
    ])
    const changes = Array.isArray(result.appearanceChanges) ? result.appearanceChanges : []
    for(const value of changes) {
        const change = asRecord(value)
        if(change.confirmedCurrent !== true || change.persistent !== true) continue
        const messageId = readText(change.sourceMessageId)
        const field = readText(change.field)
        const characterName = readText(change.character)
        const profileId = resolveCharacterProfileId(characterName, profiles)
        if(!messageId || !validMessageIds.has(messageId) || !profileId || !allowedFields.has(field)) continue
        recordVisualStateChange(memory, profileId, messageId, field, readText(change.value), change.reverted === true)
    }
}

function canReplace<T extends {pinned?:boolean; currentScene?:boolean; importance?:number; mentionCount?:number; lastSeenMessage?:number}>(
    entries:T[], limit:number, candidateScore:number, messageIndex:number
):number {
    if(entries.length < limit) return -1
    let weakestIndex = -1
    let weakestScore = Number.POSITIVE_INFINITY
    entries.forEach((entry, index) => {
        if(entry.pinned || entry.currentScene) return
        const entryScore = score(entry, messageIndex)
        if(entryScore < weakestScore) {
            weakestScore = entryScore
            weakestIndex = index
        }
    })
    return weakestIndex >= 0 && candidateScore > weakestScore ? weakestIndex : -2
}

function registerCharacterIdentity(
    char:character,
    item:Record<string, unknown>,
    memory:ChatVisualMemory,
    assetProfiles:VisualCharacterProfile[],
    messageIndex:number,
    limit:number,
    currentIds:Set<string>,
    appliedIdentityFields:string[]
):VisualCharacterProfile|undefined {
    const name = readText(item.name)
    if(!name) return
    const aliases = uniqueStrings(item.aliases)
    const renamedFrom = uniqueStrings([
        ...(Array.isArray(item.renamedFrom) ? item.renamedFrom : [item.renamedFrom]),
        ...(Array.isArray(item.previousNames) ? item.previousNames : [item.previousNames])
    ])
    const distinctPerson = item.distinctPerson === true
    const identifiers = uniqueStrings(distinctPerson ? renamedFrom : [name, ...aliases, ...renamedFrom])
    const explicitId = readText(item.id)
    const assetIdMatch = explicitId
        ? assetProfiles.filter(profile => profile.id === explicitId)
        : []
    const memoryIdMatch = explicitId
        ? memory.characters.filter(profile => profile.id === explicitId)
        : []
    const assetMatch = assetIdMatch.length === 1
        ? { profile:assetIdMatch[0], ambiguous:false }
        : memoryIdMatch.length === 1
            ? { profile:undefined, ambiguous:false }
            : identifiers.length
                ? findUniqueProfile<VisualCharacterProfile>(assetProfiles, identifiers, profileMatches)
                : { profile:undefined, ambiguous:false }
    if(assetMatch.ambiguous || assetIdMatch.length > 1) return
    if(assetMatch.profile) {
        const profile = assetMatch.profile
        const incomingNames = [name, ...aliases].filter(alias => normalizedName(alias) !== normalizedName(profile.name))
        if(incomingNames.length && !profile.manualFields?.includes('aliases')) {
            profile.aliases = uniqueStrings([...profile.aliases, ...renamedFrom, ...incomingNames])
            persistAssetProfile(char, profile)
            appliedIdentityFields.push(`${profile.id}.aliases`)
        }
        item.id = profile.id
        currentIds.add(profile.id)
        return profile
    }

    const memoryMatch = memoryIdMatch.length === 1
        ? { profile:memoryIdMatch[0], ambiguous:false }
        : identifiers.length
            ? findUniqueProfile<VisualCharacterProfile>(memory.characters, identifiers, profileMatches)
            : { profile:undefined, ambiguous:false }
    if(memoryMatch.ambiguous || memoryIdMatch.length > 1) return
    let profile = memoryMatch.profile
    const importance = Number.isFinite(Number(item.importance))
        ? Math.max(0, Math.min(10, Number(item.importance)))
        : 0
    const important = item.important === true || importance >= 6
    if(!profile && (!important || item.oneTime === true || limit <= 0)) return

    if(!profile) {
        const sourceMessageId = readText(item.sourceMessageId)
        const idBase = `visual-${fingerprint(distinctPerson ? `${normalizedName(name)}:${sourceMessageId}` : normalizedName(name))}`
        const colliding = memory.characters.find(candidate => candidate.id === idBase)
        if(colliding) return
        profile = createVisualCharacterProfile(idBase, name)
        profile.aliases = aliases
        profile.importance = importance
        profile.mentionCount = Math.max(1, Number(item.mentionCount) || 1)
        profile.lastSeenMessage = messageIndex
        const eviction = canReplace(
            memory.characters as (VisualCharacterProfile & {currentScene?:boolean})[],
            limit,
            score(profile, messageIndex),
            messageIndex
        )
        if(eviction === -2) return
        if(eviction >= 0) {
            const [replaced] = memory.characters.splice(eviction, 1)
            delete memory.currentOutfits[replaced.id]
        }
        memory.characters.push(profile)
        appliedIdentityFields.push(`${profile.id}.identity`, `${profile.id}.aliases`)
    } else {
        const isExplicitRename = renamedFrom.some(previousName => profileMatches(profile!, previousName))
        if(isExplicitRename && normalizedName(name) !== normalizedName(profile.name)) {
            if(!profile.manualFields?.includes('name')) {
                profile.aliases = uniqueStrings([...profile.aliases, profile.name, ...renamedFrom])
                profile.name = name
                appliedIdentityFields.push(`${profile.id}.name`)
            }
        }
        if(!profile.manualFields?.includes('aliases')) {
            const previousAliases = profile.aliases.join('\u0000')
            profile.aliases = uniqueStrings([...profile.aliases, ...aliases, ...renamedFrom])
            if(previousAliases !== profile.aliases.join('\u0000')) appliedIdentityFields.push(`${profile.id}.aliases`)
        }
        profile.importance = Math.max(profile.importance ?? 0, importance)
        if(profile.lastSeenMessage !== messageIndex) {
            profile.mentionCount = (profile.mentionCount ?? 0) + Math.max(1, Number(item.mentionCount) || 1)
        }
        profile.lastSeenMessage = messageIndex
    }
    item.id = profile.id
    profile.currentScene = true
    currentIds.add(profile.id)
    return profile
}

function mergeCharacterVisualData(
    profile:VisualCharacterProfile,
    item:Record<string, unknown>,
    applied:string[],
    conflicts:string[]
):void {
    const appearance = asRecord(item.appearance)
    const incoming = {
        style:asRecord(item.style),
        face:asRecord(appearance.face),
        eye:asRecord(appearance.eye),
        hair:asRecord(appearance.hair),
        body:asRecord(appearance.body),
        clothing:asRecord(appearance.clothing)
    }
    const before = new Map<string,string>()
    const visit = (target:Record<string, unknown>, source:Record<string, unknown>, prefix='') => {
        for(const [key, value] of Object.entries(source)) {
            const path = prefix ? `${prefix}.${key}` : key
            if(value && typeof value === 'object' && !Array.isArray(value)) {
                const existing = target[key]
                if(existing && typeof existing === 'object') visit(existing as Record<string, unknown>, value as Record<string, unknown>, path)
                continue
            }
            if(typeof value !== 'string' || !value.trim()) continue
            const old = target[key]
            if(typeof old === 'string' && old.trim() && old.trim() !== value.trim()) conflicts.push(`${profile.name}.${path}`)
            else if(typeof old !== 'string' || !old.trim()) before.set(path, '')
        }
    }
    visit(profile as unknown as Record<string, unknown>, incoming)
    mergeMissing(profile as unknown as Record<string, unknown>, incoming, '', new Set(profile.manualFields ?? []))
    for(const [path] of before) {
        const keys = path.split('.')
        let value:unknown = profile
        for(const key of keys) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
        if(typeof value === 'string' && value.trim()) applied.push(`${profile.name}.${path}`)
    }
}

function analyzeCharacterItem(
    char:character,
    value:unknown,
    memory:ChatVisualMemory,
    assetProfiles:VisualCharacterProfile[],
    messageIndex:number,
    limit:number,
    currentIds:Set<string>,
    sourceMessageId:string,
    appliedFields:string[],
    conflictingFields:string[]
):void {
    const item = asRecord(value)
    const name = readText(item.name)
    if(!name) return
    const aliases = uniqueStrings(item.aliases)
    const explicitId = readText(item.id)
    const identifiers = uniqueStrings([
        ...(item.distinctPerson === true ? [] : [name, ...aliases]),
        ...uniqueStrings(Array.isArray(item.renamedFrom) ? item.renamedFrom : [item.renamedFrom]),
        ...uniqueStrings(Array.isArray(item.previousNames) ? item.previousNames : [item.previousNames])
    ])
    const assetById = explicitId ? assetProfiles.filter(profile => profile.id === explicitId) : []
    const assetMatch = assetById.length === 1
        ? { profile:assetById[0], ambiguous:false }
        : explicitId ? { profile:undefined, ambiguous:false }
        : identifiers.length
            ? findUniqueProfile<VisualCharacterProfile>(assetProfiles, identifiers, profileMatches)
            : { profile:undefined, ambiguous:false }
    if(assetMatch.ambiguous) return
    if(assetMatch.profile) {
        mergeCharacterVisualData(assetMatch.profile, item, appliedFields, conflictingFields)
        persistAssetProfile(char, assetMatch.profile)
        currentIds.add(assetMatch.profile.id)
        const outfit = readText(item.currentOutfit)
        if(item.outfitChanged === true && item.outfitIsCurrent === true) {
            recordVisualStateChange(memory, assetMatch.profile.id, sourceMessageId, 'clothing.current', outfit, !outfit)
        }
        return
    }
    const memoryById = explicitId ? memory.characters.filter(profile => profile.id === explicitId) : []
    const memoryMatch = memoryById.length === 1
        ? { profile:memoryById[0], ambiguous:false }
        : explicitId ? { profile:undefined, ambiguous:false }
        : identifiers.length
            ? findUniqueProfile<VisualCharacterProfile>(memory.characters, identifiers, profileMatches)
            : { profile:undefined, ambiguous:false }
    if(memoryMatch.ambiguous) return
    let profile = memoryMatch.profile
    const importance = Number.isFinite(Number(item.importance)) ? Math.max(0, Math.min(10, Number(item.importance))) : 0
    const important = item.important === true || importance >= 6
    if(!profile && (!important || item.oneTime === true || memory.characters.length >= limit && limit <= 0)) return

    if(!profile) {
        const sourceSuffix = item.distinctPerson === true ? `:${readText(item.sourceMessageId)}` : ''
        const id = `visual-${fingerprint(`${normalizedName(name)}${sourceSuffix}`)}`
        if(memory.characters.some(candidate => candidate.id === id)) return
        profile = createVisualCharacterProfile(id, name)
        profile.aliases = aliases
        profile.importance = importance
        profile.mentionCount = Math.max(1, Number(item.mentionCount) || 1)
        profile.lastSeenMessage = messageIndex
        const eviction = canReplace(memory.characters as (VisualCharacterProfile & {currentScene?:boolean})[], limit, score(profile, messageIndex), messageIndex)
        if(eviction === -2) return
        if(eviction >= 0) {
            const [replaced] = memory.characters.splice(eviction, 1)
            delete memory.currentOutfits[replaced.id]
        }
        memory.characters.push(profile)
    } else {
        const renamedFrom = uniqueStrings([
            ...(Array.isArray(item.renamedFrom) ? item.renamedFrom : [item.renamedFrom]),
            ...(Array.isArray(item.previousNames) ? item.previousNames : [item.previousNames])
        ])
        const isExplicitRename = renamedFrom.some(previousName => profileMatches(profile!, previousName))
        if(isExplicitRename && normalizedName(name) !== normalizedName(profile.name) && !profile.manualFields?.includes('name')) {
            profile.aliases = uniqueStrings([...profile.aliases, profile.name, ...renamedFrom])
            profile.name = name
        }
        if(!profile.manualFields?.includes('aliases')) profile.aliases = uniqueStrings([...profile.aliases, ...aliases])
        profile.importance = Math.max(profile.importance ?? 0, importance)
        if(profile.lastSeenMessage !== messageIndex) {
            profile.mentionCount = (profile.mentionCount ?? 0) + Math.max(1, Number(item.mentionCount) || 1)
        }
        profile.lastSeenMessage = messageIndex
    }
    item.id = profile.id
    profile.currentScene = true
    const outfit = readText(item.currentOutfit)
    if(item.outfitChanged === true && item.outfitIsCurrent === true) {
        recordVisualStateChange(memory, profile.id, sourceMessageId, 'clothing.current', outfit, !outfit)
    }
    mergeCharacterVisualData(profile, item, appliedFields, conflictingFields)
    currentIds.add(profile.id)
}

function analyzeLocationItem(
    value:unknown,
    memory:ChatVisualMemory,
    assetLocations:VisualLocationProfile[],
    messageIndex:number,
    limit:number,
    currentIds:Set<string>
):void {
    const item = asRecord(value)
    const name = readText(item.name)
    if(!name) return
    const aliases = uniqueStrings(item.aliases)
    const assetMatch = findUniqueProfile<VisualLocationProfile>(assetLocations, [name, ...aliases], locationMatches)
    if(assetMatch.ambiguous) return
    if(assetMatch.profile) {
        currentIds.add(assetMatch.profile.id)
        return
    }
    const memoryMatch = findUniqueProfile<VisualLocationProfile>(memory.locations, [name, ...aliases], locationMatches)
    if(memoryMatch.ambiguous) return
    let profile = memoryMatch.profile
    const importance = Number.isFinite(Number(item.importance)) ? Math.max(0, Math.min(10, Number(item.importance))) : 0
    const important = item.important === true || importance >= 6
    if(!profile && (!important || item.oneTime === true || limit <= 0)) return
    if(!profile) {
        profile = createVisualLocationProfile(`visual-${fingerprint(normalizedName(name))}`, name)
        profile.aliases = aliases
        profile.importance = importance
        profile.mentionCount = Math.max(1, Number(item.mentionCount) || 1)
        profile.lastSeenMessage = messageIndex
        const eviction = canReplace(memory.locations as (VisualLocationProfile & {currentScene?:boolean})[], limit, score(profile, messageIndex), messageIndex)
        if(eviction === -2) return
        if(eviction >= 0) memory.locations.splice(eviction, 1)
        memory.locations.push(profile)
    } else {
        if(!profile.manualFields?.includes('aliases')) profile.aliases = uniqueStrings([...profile.aliases, ...aliases])
        profile.importance = Math.max(profile.importance ?? 0, importance)
        profile.mentionCount = (profile.mentionCount ?? 0) + Math.max(1, Number(item.mentionCount) || 1)
        profile.lastSeenMessage = messageIndex
    }
    profile.currentScene = true
    mergeMissing(profile as unknown as Record<string, unknown>, {
        structure: readText(item.structure),
        interior: readText(item.interior),
        lighting: readText(item.lighting),
        colorPalette: readText(item.colorPalette),
        atmosphere: readText(item.atmosphere)
    }, '', new Set(profile.manualFields ?? []))
    currentIds.add(profile.id)
}

function validateVisualAnalysis(value:Record<string, unknown>):Record<string, unknown> {
    const output = { ...value }
    for(const key of ['characters', 'locations', 'appearanceChanges']) {
        const collection = output[key]
        if(collection !== undefined && !Array.isArray(collection)) throw new Error(`Visual analysis field "${key}" must be an array.`)
        if(Array.isArray(collection)) {
            output[key] = collection.filter(item => {
                if(!item || typeof item !== 'object' || Array.isArray(item)) return false
                const record = item as Record<string, unknown>
                if(key === 'characters' || key === 'locations') return typeof record.name === 'string' && !!record.name.trim()
                return typeof record.character === 'string' && typeof record.field === 'string'
            })
        }
    }
    if(!['characters', 'locations', 'appearanceChanges'].some(key => Array.isArray(output[key]))) {
        throw new Error('Visual analysis JSON did not contain a recognized result array.')
    }
    return output
}

function isProviderContentBlock(reason:string):boolean {
    return /PROHIBITED_CONTENT|content[_ -]?filter|safety[_ -]?blocked|blocked by (?:the )?provider/i.test(reason)
}

export function analyzeVisualMemory(char:character, chat:Chat, providedAssetCatalog?:CharacterImageAsset[], force = false):Promise<void> {
    const settings = getVisualSettings(char)
    if(!settings.enabled || (!settings.autoAnalyze && !force) || chat.message.length === 0) return Promise.resolve()
    const active = activeVisualAnalyses.get(chat)
    if(active) return active
    const catalogVisitsBefore = getVisualAssetCatalogStats(char).entriesVisited
    const assetCatalog = providedAssetCatalog ?? getVisualCharacterAssets(char)
    const startedAt = Date.now()
    const memory = getChatVisualMemory(chat)
    memory.lastAnalysisSource = 'chat-response'
    memory.lastRelatedMessageIds = []
    memory.lastAppliedFields = []
    memory.lastConflictingFields = []
    if(!providedAssetCatalog) {
        memory.lastAnalysisMetrics = {
            elapsedMs:0,
            assetMetadataCount:getVisualAssetCatalogVisitDelta(char, catalogVisitsBefore),
            imageBytesRead:0,
            visionCalls:0,
            llmCalls:0,
            cacheHits:0
        }
    }
    const task = analyzeVisualMemoryInternal(char, chat, assetCatalog, force).finally(() => {
        memory.lastAnalysisMetrics!.elapsedMs = Date.now() - startedAt
        activeVisualAnalyses.delete(chat)
    })
    activeVisualAnalyses.set(chat, task)
    return task
}

async function analyzeVisualMemoryInternal(char:character, chat:Chat, assetCatalog:CharacterImageAsset[], force = false):Promise<void> {
    const settings = getVisualSettings(char)
    if(!settings.enabled || (!settings.autoAnalyze && !force) || chat.message.length === 0) return
    const memory = getChatVisualMemory(chat)
    const windowSize = Math.max(1, settings.recentMessages)
    const recent = chat.message.slice(-windowSize)
    const currentFingerprint = fingerprint(recent.map((message, index) =>
        `${visualMessageId(message, chat.message.length - recent.length + index)} ${message.role}: ${message.data}`
    ).join('\n'))
    const previousCount = memory.lastAnalyzedMessageCount ?? 0
    const modelId = visualModelId()
    const legacyLanguageFailure = !memory.lastFailedAnalysisFingerprint &&
        /English visual profile conversion returned non-English descriptions/i.test(memory.lastAnalysisResult ?? '')
    if(!force && memory.lastAnalyzedFingerprint === currentFingerprint && previousCount === chat.message.length && !legacyLanguageFailure) return
    if(!force && memory.lastFailedAnalysisFingerprint === currentFingerprint && memory.lastFailedAnalysisModel === modelId) return
    const modelDetails = analysisModelDetails(modelId)
    memory.lastAnalysisModel = modelDetails.id
    memory.lastAnalysisProvider = modelDetails.provider
    memory.lastAnalysisFailureKind = undefined
    memory.lastVisualTranslationFailureKind = undefined

    let messagesToAnalyze = recent
    if(!legacyLanguageFailure && !force && chat.message.length > previousCount && previousCount > 0) {
        const oldContext = chat.message.slice(Math.max(0, previousCount - windowSize), previousCount)
        const oldFingerprint = fingerprint(oldContext.map((message, index) =>
            `${visualMessageId(message, Math.max(0, previousCount - oldContext.length + index))} ${message.role}: ${message.data}`
        ).join('\n'))
        if(oldFingerprint === memory.lastAnalyzedFingerprint) {
            messagesToAnalyze = chat.message.slice(previousCount)
        }
    }
    const messageIds = messagesToAnalyze.map(message => visualMessageId(message, chat.message.indexOf(message)))
    memory.lastRelatedMessageIds = messageIds
    const currentMessageIds = new Set(chat.message.map(visualMessageId))
    const analyzedMessageIds = new Set(messageIds)
    memory.stateChanges = (memory.stateChanges ?? []).filter(change =>
        currentMessageIds.has(change.messageId) && !analyzedMessageIds.has(change.messageId)
    )
    rebuildChatVisualState(memory, chat)
    const source = messagesToAnalyze.map((message, index) =>
        `[messageId:${messageIds[index]}] ${message.role}: ${message.data}`
    ).join('\n').slice(-16_000)
    if(!source.trim()) {
        memory.lastAnalyzedFingerprint = currentFingerprint
        memory.lastAnalyzedMessageCount = chat.message.length
        memory.lastFailedAnalysisFingerprint = undefined
        memory.lastFailedAnalysisModel = undefined
        return
    }
    const knownCharacters = [...getAssetProfiles(char, assetCatalog), ...memory.characters]
    const knownLocations = [...getVisualLorebookCatalog(char, chat), ...memory.locations]
    updateLocalVisualScene(source, memory, knownCharacters, knownLocations)
    const hasUnresolvedEntity = visualEntityCandidates(source).some(name => isUnresolvedVisualCandidate(name, knownCharacters, knownLocations))
    const hasStateChangeCue = /(?:change(?:d|s)?|dye(?:d|s)?|cut(?:s)?|grow(?:s|n)?|gain(?:ed|s)?|lose(?:s|t)? weight|scar(?:red|s)?|injur(?:ed|y)|recover(?:ed|s)?|pregnan(?:t|cy)|wear(?:s|ing)?|change(?:s|d)? clothes|환복|갈아입|염색|잘랐|길렀|살이 찌|살이 빠|흉터|부상|회복|임신|출산|옷을 입|옷을 벗|머리카락|체중)/i.test(source)
    if(!hasUnresolvedEntity && !hasStateChangeCue) {
        memory.lastAnalyzedFingerprint = currentFingerprint
        memory.lastAnalyzedMessageCount = chat.message.length
        memory.lastFailedAnalysisFingerprint = undefined
        memory.lastFailedAnalysisModel = undefined
        memory.lastAnalysisResult = 'Local lookup resolved the supplied messages; no model analysis was needed.'
        return
    }

    updateAnalysisMetrics(char, { llmCalls:1 })
    const formated:OpenAIChat[] = [
        {
            role:'system',
            content:'Analyze only the supplied roleplay excerpts. Return JSON with arrays "characters", "locations", and "appearanceChanges". For each character include name, aliases, renamedFrom (only for an explicit accepted present-time name change), id (only if an exact stable ID was supplied), distinctPerson (true only when the same display name clearly belongs to a different person), important, oneTime, importance (0-10), mentionCount, sourceMessageId, currentOutfit, outfitChanged, outfitIsCurrent, style, and appearance {face, eye, hair, body, clothing}. Preserve names and aliases exactly as written, including Korean; never translate identifiers. Report an explicit rename only when the narrative clearly confirms the same person adopted the new name; do not infer identity from ambiguous pronouns or name similarity. Include sourceMessageId from supplied excerpts. Write visual descriptions in natural English; traits explicitly stated only; unknown fields empty. Mark important only recurring, central, or consequential characters; exclude incidental extras. Record outfit changes only when the narrative confirms a present-time change; set outfitChanged and outfitIsCurrent true, and use an empty currentOutfit to clear the current outfit when a confirmed change removes it. Ignore hypothetical, remembered, planned, dream, and alternate-timeline changes. appearanceChanges entries require character, sourceMessageId, field, value, confirmedCurrent:true, persistent:true, and reverted (optional). Only report confirmed continuing changes to hair color/length/style/details, body build/skin/proportions/distinctiveFeatures, face shape/features, or eye color/shape/details. Represent a change back to an earlier state with reverted:true. Never store expressions, poses, actions, camera framing, temporary injury effects, or scene direction as stable appearance. For locations include name, aliases, important, oneTime, importance, mentionCount, structure, interior, lighting, colorPalette, atmosphere. JSON only.'
        },
        { role:'user', content:source }
    ]

    try {
        const response = await requestChatData({
            formated,
            currentChar:char,
            temperature:0.1,
            maxTokens:1000,
            bias:{},
            useStreaming:false,
            noMultiGen:true,
            chatId:chat.id,
            blockPlugins:true,
            disableThinking:true
        }, 'submodel')
        if(response.type !== 'success') {
            const reason = typeof response.result === 'string' ? response.result : 'Analysis returned an unexpected response type.'
            memory.lastAnalysisModel = response.model ?? modelId
            memory.lastAnalysisProvider = analysisModelDetails(memory.lastAnalysisModel).provider
            memory.lastAnalysisFailureKind = isProviderContentBlock(reason) ? 'provider-content-block' : 'request-failure'
            memory.lastAnalysisResult = `Analysis failed (${memory.lastAnalysisFailureKind}): ${reason}`.slice(0, 8000)
            memory.lastFailedAnalysisFingerprint = currentFingerprint
            memory.lastFailedAnalysisModel = modelId
            console.warn('Visual Manager analysis was skipped:', reason)
            return
        }
        memory.lastAnalysisModel = response.model ?? modelId
        memory.lastAnalysisProvider = analysisModelDetails(memory.lastAnalysisModel).provider
        const rawResult = validateVisualAnalysis(parseModelJson(response.result))
        const currentCharacters = new Set<string>()
        const messageIndex = chat.message.length
        const rawCharacters = Array.isArray(rawResult.characters) ? rawResult.characters : []
        for(const value of rawCharacters) {
            const item = asRecord(value)
            const suppliedMessageId = readText(item.sourceMessageId)
            const sourceMessageId = messageIds.includes(suppliedMessageId) ? suppliedMessageId : messageIds.at(-1) ?? ''
            registerCharacterIdentity(
                char,
                item,
                memory,
                getAssetProfiles(char, assetCatalog),
                messageIndex,
                settings.maxCharacters,
                currentCharacters,
                memory.lastAppliedFields!
            )
            if(item.sourceMessageId === undefined && sourceMessageId) item.sourceMessageId = sourceMessageId
        }
        const result = await translateVisualFieldsIfNeeded(rawResult, char)
        if(Array.isArray(result.characters)) linkUnambiguousNamedAssets(char, result.characters, assetCatalog)
        const assetProfiles = getAssetProfiles(char, assetCatalog)
        const assetLocations = getVisualLorebookCatalog(char, chat)
        const currentLocations = new Set<string>()
        memory.characters.forEach(profile => profile.currentScene = false)
        memory.locations.forEach(profile => profile.currentScene = false)
        if(Array.isArray(result.characters)) {
            for(const item of result.characters) {
                const itemRecord = asRecord(item)
                const suppliedMessageId = readText(itemRecord.sourceMessageId)
                const sourceMessageId = messageIds.includes(suppliedMessageId) ? suppliedMessageId : messageIds.at(-1) ?? ''
                analyzeCharacterItem(char, item, memory, assetProfiles, messageIndex, settings.maxCharacters, currentCharacters, sourceMessageId, memory.lastAppliedFields!, memory.lastConflictingFields!)
            }
        }
        if(Array.isArray(result.locations)) {
            for(const item of result.locations) {
                analyzeLocationItem(item, memory, assetLocations, messageIndex, settings.maxLocations, currentLocations)
            }
        }
        applyAppearanceStateChanges(result, messageIds, memory, [...assetProfiles, ...memory.characters])
        rebuildChatVisualState(memory, chat)
        memory.currentCharacterIds = [...currentCharacters]
        memory.currentLocationIds = [...currentLocations]
        backfillUnambiguousImageCharacterLinks(memory, chat, [...assetProfiles, ...memory.characters])
        memory.lastAppliedFields = [...new Set([
            ...memory.lastAppliedFields,
            ...memory.stateChanges.filter(change => messageIds.includes(change.messageId)).map(change => `${change.characterId}.${change.field}`)
        ])]
        memory.lastSavedAt = Date.now()
        memory.lastAnalysisResult = JSON.stringify(result).slice(0, 8000)
        memory.lastAnalyzedFingerprint = currentFingerprint
        memory.lastAnalyzedMessageCount = chat.message.length
        memory.lastFailedAnalysisFingerprint = undefined
        memory.lastFailedAnalysisModel = undefined
        memory.lastAnalysisFailureKind = undefined
    } catch(error) {
        console.warn('Visual Manager analysis failed; image generation will continue without new visual memory.', error)
        const reason = error instanceof Error ? error.message : String(error)
        memory.lastAnalysisFailureKind = /JSON|array|object|Visual analysis/i.test(reason) ? 'json-validation' : 'request-failure'
        memory.lastAnalysisResult = `Analysis failed (${memory.lastAnalysisFailureKind}): ${reason}`.slice(0, 8000)
        memory.lastFailedAnalysisFingerprint = currentFingerprint
        memory.lastFailedAnalysisModel = modelId
    }
}

function profileDescription(profile:VisualCharacterProfile, outfit:string, sourceDescription='', appearanceState:Record<string,string> = {}):string {
    const fields:Array<[string,string]> = [
        ['style.medium',profile.style.medium], ['style.artStyle',profile.style.artStyle],
        ['style.lineArt',profile.style.lineArt], ['style.shading',profile.style.shading],
        ['style.colorPalette',profile.style.colorPalette], ['style.additional',profile.style.additional],
        ['face.shape',profile.face.shape], ['face.features',profile.face.features],
        ['eye.color',profile.eye.color], ['eye.shape',profile.eye.shape], ['eye.details',profile.eye.details],
        ['hair.color',profile.hair.color], ['hair.length',profile.hair.length],
        ['hair.style',profile.hair.style], ['hair.details',profile.hair.details],
        ['body.build',profile.body.build], ['body.skin',profile.body.skin],
        ['body.proportions',profile.body.proportions], ['body.distinctiveFeatures',profile.body.distinctiveFeatures]
    ]
    const parts = fields
        .filter(([path, value]) => value && !appearanceState[path])
        .map(([, value]) => value)
    parts.push(...Object.entries(appearanceState).map(([field, value]) => `${field.replaceAll('.', ' ')}: ${value}`))
    if(outfit) parts.push(outfit)
    else {
        const preset = profile.clothing.presets[profile.clothing.defaultPreset]
        if(preset?.description) parts.push(preset.description)
    }
    const sourceVisuals = sourceVisualDescription(sourceDescription)
    if(sourceVisuals) parts.push(`Character reference details: ${sourceVisuals}`)
    return parts.join(', ')
}

function locationDescription(profile:VisualLocationProfile):string {
    return [profile.structure, profile.interior, profile.lighting, profile.colorPalette, profile.atmosphere].filter(Boolean).join(', ')
}

export interface VisualPromptContext {
    characterIds?:string[]
    locationIds?:string[]
    identifiers?:string[]
    sceneSpec?:string
    unresolvedReferences?:string[]
}

export function resolveVisualSceneReferences(char:character, chat:Chat, spec:ImgGenSceneSpec):VisualPromptContext {
    const memory = getChatVisualMemory(chat)
    const characters = [...getAssetProfiles(char), ...memory.characters]
    const locations = [...getVisualLorebookCatalog(char, chat), ...memory.locations]
    const characterIds:string[] = []
    const locationIds:string[] = []
    const unresolvedReferences:string[] = []
    const resolvedCharacters = spec.characters.map(input => {
        const profile = input.id
            ? characters.find(candidate => candidate.id === input.id)
            : input.name
                ? findUniqueProfile<VisualCharacterProfile>(characters, [input.name], profileMatches).profile
                : undefined
        if(profile) characterIds.push(profile.id)
        else unresolvedReferences.push(`Character ${input.name ?? input.id ?? '(missing identifier)'} could not be resolved without guessing.`)
        return {
            ...input,
            resolvedId:profile?.id,
            profileSource:profile?.source,
            resolution:profile ? 'matched' : 'unresolved',
            visualProfile:profile ? {
                style:profile.style,
                face:profile.face,
                eye:profile.eye,
                hair:profile.hair,
                body:profile.body,
                clothing:profile.clothing
            } : undefined,
            appearanceState:profile ? memory.appearanceStates?.[profile.id] : undefined,
            currentOutfit:profile
                ? memory.currentOutfits[profile.id] ?? profile.clothing.presets[profile.clothing.defaultPreset]?.description ?? ''
                : undefined,
            fieldSources:{
                action:'main-llm',
                interaction:'main-llm',
                expression:'main-llm',
                pose:'main-llm',
                clothingChange:'main-llm-confirmed-current-change',
                visualProfile:profile ? `visual-profile:${profile.id}` : 'unresolved',
                appearanceState:profile ? `chat-state:${profile.id}` : 'unresolved',
                currentOutfit:profile ? `chat-state:${profile.id}` : 'unresolved'
            }
        }
    })
    const rawLocation = spec.scene.location
    const locationInput = typeof rawLocation === 'string' ? { name:rawLocation } : rawLocation
    const locationProfile = locationInput
        ? locationInput.id
            ? locations.find(candidate => candidate.id === locationInput.id)
            : locationInput.name
                ? findUniqueProfile<VisualLocationProfile>(locations, [locationInput.name], locationMatches).profile
                : undefined
        : undefined
    if(locationProfile) locationIds.push(locationProfile.id)
    else if(locationInput) unresolvedReferences.push(`Location ${locationInput.name ?? locationInput.id ?? '(missing identifier)'} could not be resolved without guessing.`)
    const sceneSpec = JSON.stringify({
        ...spec,
        resolvedCharacters,
        resolvedLocation:locationInput ? {
            ...locationInput,
            resolvedId:locationProfile?.id,
            profileSource:locationProfile?.source,
            resolution:locationProfile ? 'matched' : 'unresolved',
            visualProfile:locationProfile ? {
                structure:locationProfile.structure,
                interior:locationProfile.interior,
                lighting:locationProfile.lighting,
                colorPalette:locationProfile.colorPalette,
                atmosphere:locationProfile.atmosphere
            } : undefined,
            fieldSources:locationProfile ? `visual-profile:${locationProfile.id}` : 'unresolved'
        } : undefined,
        fieldSources:{
            characterSceneDetails:'main-llm',
            locationAndSceneDetails:'main-llm',
            characterIdentityAndStyle:'visual-profile',
            locationContinuity:'visual-profile'
        }
    })
    return {
        characterIds:[...new Set(characterIds)],
        locationIds:[...new Set(locationIds)],
        identifiers:uniqueStrings([
            ...spec.characters.flatMap(input => [input.id ?? '', input.name ?? '']),
            ...(typeof rawLocation === 'string' ? [rawLocation] : rawLocation ? [rawLocation.id ?? '', rawLocation.name ?? ''] : [])
        ]),
        sceneSpec,
        unresolvedReferences
    }
}

export async function prepareVisualImagePrompt(prompt:string, char:character, context:VisualPromptContext = {}):Promise<string> {
    const settings = getVisualSettings(char)
    if(!settings.enabled) return prompt
    const chat = char.chats?.[char.chatPage]
    if(!chat) return prompt
    const memory = getChatVisualMemory(chat)
    memory.lastDebugStatus = [...(context.unresolvedReferences ?? [])]
    memory.lastDebugSceneSpec = context.sceneSpec
    const startedAt = Date.now()
    const catalogVisitsBefore = getVisualAssetCatalogStats(char).entriesVisited
    const assetCatalog = getVisualCharacterAssets(char)
    memory.lastAnalysisMetrics = {
        elapsedMs:0,
        assetMetadataCount:getVisualAssetCatalogVisitDelta(char, catalogVisitsBefore),
        imageBytesRead:0,
        visionCalls:0,
        llmCalls:0,
        cacheHits:0
    }
    let assets = getAssetProfiles(char, assetCatalog)
    const db = getDatabase()
    const referencedAssets = resolveChatAssetReferences(chat, char, assetCatalog)
    let characterCatalog = [...assets, ...memory.characters]
    const selectedCharacterIds = new Set((context.characterIds ?? []).filter(id =>
        characterCatalog.some(profile => profile.id === id)
    ))
    for(const id of characterCatalog
        .filter(profile => isUnambiguousPromptMatch(profile, characterCatalog, prompt, memory.currentCharacterIds))
        .map(profile => profile.id)) selectedCharacterIds.add(id)
    if(settings.autoAnalyze) {
        await analyzeVisualMemory(char, chat, assetCatalog)
        assets = getAssetProfiles(char, assetCatalog)
        characterCatalog = [...assets, ...memory.characters]
        selectedCharacterIds.clear()
        for(const profile of characterCatalog) {
            if(isUnambiguousPromptMatch(profile, characterCatalog, prompt, memory.currentCharacterIds)) selectedCharacterIds.add(profile.id)
        }
        for(const id of context.characterIds ?? []) {
            if(characterCatalog.some(profile => profile.id === id)) selectedCharacterIds.add(id)
        }
        for(const id of memory.currentCharacterIds) selectedCharacterIds.add(id)
    }
    const selectedProfiles:string[] = []
    for(const profile of assets) {
        if(!selectedCharacterIds.has(profile.id)) continue
        const assetMatches = referencedAssets.filter(asset => {
            if(profile.id === char.chaId && asset.kind === 'emotion') return true
            return [profile.name, ...profile.aliases].some(alias => normalizedName(alias) === normalizedName(asset.name))
        })
        if(assetMatches.length === 1) {
            profile.assetUri = assetMatches[0].uri
            profile.assetName = assetMatches[0].name
            profile.assetKind = assetMatches[0].kind
        }
        if(settings.autoAnalyze) await analyzeVisualAssetIfNeeded(char, profile, false, assetMatches.length === 1 ? assetMatches[0] : undefined)
        const linkedCharacter = db.characters.find(item => item.chaId === profile.id)
        const source = profile.id === char.chaId
            ? char.desc
            : linkedCharacter && linkedCharacter.type !== 'group' ? linkedCharacter.desc : ''
        const description = profileDescription(profile, memory.currentOutfits[profile.id] ?? '', source, memory.appearanceStates?.[profile.id])
        if(description) selectedProfiles.push(`${profile.name}: ${description}`)
        memory.lastDebugStatus?.push(`${profile.name}: CHARX asset/profile${profile.assetUri ? ` (${profile.assetKind ?? 'linked'}: ${profile.assetUri})` : ''}; Vision ${profile.visionAnalysisStatus ?? 'not needed'}`)
    }
    for(const profile of memory.characters) {
        if(!selectedCharacterIds.has(profile.id)) continue
        const description = profileDescription(profile, memory.currentOutfits[profile.id] ?? '', '', memory.appearanceStates?.[profile.id])
        if(description) selectedProfiles.push(`${profile.name}: ${description}`)
        memory.lastDebugStatus?.push(`${profile.name}: Visual Memory profile`)
    }

    if(settings.autoAnalyze) await classifyRelevantLorebookLocations(char, chat, prompt)
    const locations = getVisualLorebookCatalog(char, chat)
    const locationCatalog = [...locations, ...memory.locations]
    const selectedLocationIds = new Set((context.locationIds ?? []).filter(id =>
        locationCatalog.some(profile => profile.id === id)
    ))
    for(const id of locationCatalog
        .filter(profile => isUnambiguousPromptMatch(profile, locationCatalog, prompt, memory.currentLocationIds))
        .map(profile => profile.id)) selectedLocationIds.add(id)
    if(settings.autoAnalyze) {
        for(const id of memory.currentLocationIds) selectedLocationIds.add(id)
    }
    const selectedLocations = locations.flatMap(profile => {
        if(!selectedLocationIds.has(profile.id)) return []
        const description = locationDescription(profile)
        return description ? [`${profile.name}: ${description}`] : []
    })
    for(const profile of memory.locations) {
        if(!selectedLocationIds.has(profile.id)) continue
        const description = locationDescription(profile)
        if(description) selectedLocations.push(`${profile.name}: ${description}`)
    }
    getLorebookEntries(char, chat).forEach(({ entry, scope }, index) => {
        if(entry.mode === 'folder') return
        const id = `${scope}:${entry.id ?? `${entry.comment || entry.key}-${index}`}`
        const classification = char.visualLoreClassificationCache?.[id]?.classification ?? classifyLorebookEntry(entry)
        if(classification !== 'place' || locations.some(profile => profile.id === id)) {
            memory.lastDebugStatus?.push(`${entry.comment || entry.key}: Lorebook ${classification}`)
        }
    })
    if(referencedAssets.length > 0) {
        memory.lastDebugStatus?.push(`Chat-referenced original asset(s): ${referencedAssets.map(asset => `${asset.kind}:${asset.name} (${asset.uri})`).join(', ')}`)
    }

    const continuity = [
        ...selectedProfiles.map(value => `Character visual identity: ${value}`),
        ...selectedLocations.map(value => `Location visual identity: ${value}`)
    ]
    const addition = continuity.length
        ? `[Visual continuity: preserve each named character's individual art style and stable appearance while keeping the scene composition harmonious. Do not change the described action, expression, or camera framing. ${continuity.join(' | ')}]`
        : ''
    const finalPrompt = addition ? `${prompt}\n\n${addition}` : prompt
    try {
        const englishPrompt = await translateScenePromptIfNeeded(finalPrompt, char, memory, [
            ...(context.identifiers ?? []),
            ...characterCatalog.flatMap(profile => [profile.name, ...profile.aliases]),
            ...locationCatalog.flatMap(profile => [profile.name, ...profile.aliases])
        ])
        memory.lastAnalysisMetrics!.elapsedMs = Date.now() - startedAt
        if(settings.debug) memory.lastDebugPrompt = englishPrompt
        return englishPrompt
    } catch(error) {
        const reason = `English prompt conversion failed; using the original image prompt: ${error instanceof Error ? error.message : String(error)}`
        memory.lastDebugStatus.push(reason)
        memory.lastAnalysisMetrics!.elapsedMs = Date.now() - startedAt
        if(settings.debug) {
            memory.lastDebugPrompt = prompt
            memory.lastDebugStatus.push('Visual profile additions were omitted after prompt conversion failed.')
        }
        console.warn('Visual Manager could not convert the final image prompt to English; using the original prompt.', error)
        return prompt
    }
}

export function recordVisualImageDecision(char:character, reason:string):void {
    if(!char.visualManagerSettings?.debug) return
    const chat = char.chats?.[char.chatPage]
    if(!chat) return
    const memory = getChatVisualMemory(chat)
    memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), reason]
}

function profileHasVisualGaps(profile:VisualCharacterProfile):boolean {
    return [
        profile.style.medium, profile.style.artStyle, profile.style.lineArt, profile.style.shading,
        profile.style.colorPalette, profile.style.additional, profile.face.shape, profile.face.features,
        profile.eye.color, profile.eye.shape, profile.eye.details, profile.hair.color, profile.hair.length,
        profile.hair.style, profile.hair.details, profile.body.build, profile.body.skin,
        profile.body.proportions, profile.body.distinctiveFeatures
    ].some(value => !value.trim())
}

function extractInitialProfilesFromPrompt(
    char:character,
    chat:Chat,
    imageId:string,
    prompt:string,
    messageId?:string,
    linkedCharacterIds:string[] = []
):Promise<void> {
    const active = activeInitialProfileExtractions.get(chat)
    const extraction = active
        ? active.then(
            () => extractInitialProfilesFromPromptOnce(char, chat, imageId, prompt, messageId, linkedCharacterIds),
            () => extractInitialProfilesFromPromptOnce(char, chat, imageId, prompt, messageId, linkedCharacterIds)
        )
        : extractInitialProfilesFromPromptOnce(char, chat, imageId, prompt, messageId, linkedCharacterIds)
    let task:Promise<void>
    task = extraction.finally(() => {
        if(activeInitialProfileExtractions.get(chat) === task) activeInitialProfileExtractions.delete(chat)
    })
    activeInitialProfileExtractions.set(chat, task)
    return task
}

async function extractInitialProfilesFromPromptOnce(
    char:character,
    chat:Chat,
    imageId:string,
    prompt:string,
    messageId?:string,
    linkedCharacterIds:string[] = []
):Promise<void> {
    const settings = getVisualSettings(char)
    if(!settings.enabled || !settings.autoAnalyze) return
    const memory = getChatVisualMemory(chat)
    const targetIds = new Set([...memory.currentCharacterIds, ...linkedCharacterIds])
    const assetProfiles = getAssetProfiles(char)
    const allKnownProfiles = [...assetProfiles, ...memory.characters]
    const promptCharacterIds = new Set(allKnownProfiles
        .filter(profile => [profile.name, ...profile.aliases].some(name => matchesName(prompt, name)))
        .map(profile => profile.id))
    const explicitMemoryIds = [...new Set(linkedCharacterIds.filter(id =>
        memory.characters.some(profile => profile.id === id)
    ))]
    const associatedIds = explicitMemoryIds.length > 0
        ? explicitMemoryIds
        : promptCharacterIds.size === 1 ? [...promptCharacterIds] : []
    const targets = memory.characters.filter(profile =>
        targetIds.has(profile.id) &&
        !profile.initialImageVisionStatus &&
        associatedIds.length === 1 &&
        associatedIds.includes(profile.id) &&
        (explicitMemoryIds.includes(profile.id) || [profile.name, ...profile.aliases].some(name => matchesName(prompt, name)))
    )
    if(targets.length === 0) {
        memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), 'Initial image Vision analysis skipped: no single unambiguous Visual Memory character was associated with the image prompt, or its first-image analysis is already cached.']
        return
    }
    const savedImageRecord = targets[0].initialImageReferenceId
        ? memory.recentImages?.find(image => image.id === targets[0].initialImageReferenceId)
        : undefined
    const analysisImageId = savedImageRecord?.id ?? imageId
    const analysisPrompt = savedImageRecord?.prompt ?? prompt
    const analysisMessageId = savedImageRecord?.messageId ?? messageId
    if(targets[0].initialImageReferenceId && !savedImageRecord) {
        const reason = 'The original first-image prompt is no longer available for a safe comparison.'
        targets[0].initialImageVisionStatus = 'unavailable'
        targets[0].initialImageVisionFailure = reason
        memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), reason]
        return
    }

    const modelId = visualModelId()
    const sourceFingerprint = targets[0].initialImagePromptFingerprint ?? fingerprint(`${modelId}\n${analysisPrompt}`)
    for(const profile of targets) {
        profile.initialImagePromptFingerprint ??= sourceFingerprint
        profile.initialImageReferenceId ??= analysisImageId
        profile.initialImageVisionModel = modelId
        profile.initialImageVisionStatus = 'pending'
    }

    const applied:string[] = []
    const conflicts:string[] = []
    try {
        const model = getModelInfo(modelId)
        if(!model.flags.includes(LLMFlags.hasImageInput)) {
            for(const profile of targets) {
                profile.initialImageVisionStatus = 'unavailable'
                profile.initialImageVisionFailure = `Selected submodel "${modelId}" does not support image input.`
            }
            memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), 'Initial image Vision analysis skipped: selected submodel does not support image input.']
            return
        }

        const imageAsset = await getInlayAsset(analysisImageId)
        if(!imageAsset || imageAsset.type !== 'image' || typeof imageAsset.data !== 'string') {
            throw new Error('The saved generated image could not be loaded for its first Vision analysis.')
        }
        const dataUriMatch = imageAsset.data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s)
        if(!dataUriMatch) throw new Error('The saved generated image is not a supported base64 image.')
        const imageBytes = Buffer.from(dataUriMatch[2], 'base64')
        if(imageBytes.length === 0 || imageBytes.length > 15 * 1024 * 1024) {
            throw new Error('The saved generated image is empty or exceeds the 15 MiB Visual Manager analysis limit.')
        }
        const contentHash = await hashImage(new Uint8Array(imageBytes))
        updateAnalysisMetrics(char, { imageBytesRead:imageBytes.length, visionCalls:1, llmCalls:1 })

        const result = await requestChatData({
            formated:[
                {
                    role:'system',
                    content:'Analyze the supplied first generated character image and compare it with the exact final image prompt. Return JSON {"profiles":[{"id":"...","style":{"medium":"","artStyle":"","lineArt":"","shading":"","colorPalette":"","additional":""},"appearance":{"face":{"shape":"","features":""},"eye":{"color":"","shape":"","details":""},"hair":{"color":"","length":"","style":"","details":""},"body":{"build":"","skin":"","proportions":"","distinctiveFeatures":""}},"conflicts":[],"currentOutfit":"","outfitIsCurrent":false}]}. The image is a standalone image for exactly one identified character. Preserve the supplied ID. Report only directly visible stable identity or rendering traits, not expression, pose, action, framing, temporary injury, or inferred traits. Compare each visible trait with the final prompt and supplied established profile: include a field name in conflicts when the rendered image contradicts an explicitly stated prompt/profile value; conflicting image observations must not be used. Do not repeat prompt/profile values as image observations. Only return additional visible values that do not conflict. Keep unknown fields empty. Clothing is current chat state only, never permanent identity; return a concise currentOutfit only when clearly visible and outfitIsCurrent true. Use natural English for all visual descriptions; JSON only.'
                },
                {
                    role:'user',
                    content:JSON.stringify({
                        imageId:analysisImageId,
                        messageId:analysisMessageId,
                        characters:targets.map(profile => ({
                            id:profile.id,
                            name:profile.name,
                            aliases:profile.aliases,
                            establishedProfile:{
                                style:profile.style,
                                face:profile.face,
                                eye:profile.eye,
                                hair:profile.hair,
                                body:profile.body
                            }
                        })),
                        finalPrompt:analysisPrompt.slice(0, 12000)
                    }),
                    multimodals:[{type:'image', base64:imageAsset.data}]
                }
            ],
            currentChar:char,
            temperature:0,
            maxTokens:1100,
            bias:{},
            useStreaming:false,
            noMultiGen:true,
            chatId:chat.id,
            blockPlugins:true,
            disableThinking:true
        }, 'submodel')
        if(result.type !== 'success') throw new Error(typeof result.result === 'string' ? result.result : 'Initial image Vision analysis failed.')
        const analyzed = await translateVisualFieldsIfNeeded(parseModelJson(result.result), char)
        const extracted = Array.isArray(analyzed.profiles) ? analyzed.profiles : []
        for(const value of extracted) {
            const item = asRecord(value)
            const profile = targets.find(candidate => candidate.id === readText(item.id))
            if(!profile) continue
            const rejectedFields = uniqueStrings(item.conflicts)
            conflicts.push(...rejectedFields.map(field => `${profile.name}.${field}`))
            const safeItem = {
                ...item,
                style:filterVisualConflicts(asRecord(item.style), rejectedFields, 'style'),
                appearance:{
                    face:filterVisualConflicts(asRecord(asRecord(item.appearance).face), rejectedFields, 'face'),
                    eye:filterVisualConflicts(asRecord(asRecord(item.appearance).eye), rejectedFields, 'eye'),
                    hair:filterVisualConflicts(asRecord(asRecord(item.appearance).hair), rejectedFields, 'hair'),
                    body:filterVisualConflicts(asRecord(asRecord(item.appearance).body), rejectedFields, 'body')
                }
            }
            mergeCharacterVisualData(profile, safeItem, applied, conflicts)
            profile.initialImageContentHash = contentHash
            profile.initialImageVisionStatus = 'complete'
            profile.initialImageVisionFailure = undefined
            const outfit = readText(item.currentOutfit)
            if(item.outfitIsCurrent === true && analysisMessageId) {
                recordVisualStateChange(memory, profile.id, analysisMessageId, 'clothing.current', outfit, !outfit)
            }
        }
        for(const profile of targets) {
            profile.initialImageContentHash = contentHash
            profile.initialImageVisionStatus = 'complete'
        }
        rebuildChatVisualState(memory, chat)
        const imageRecord = memory.recentImages?.find(image => image.id === analysisImageId)
        if(imageRecord) {
            for(const profile of targets) imageRecord.profileVersions[profile.id] = fingerprint(JSON.stringify(profile))
        }
        memory.lastAnalysisSource = 'generated-image-vision'
        memory.lastAnalysisResult = JSON.stringify(analyzed).slice(0, 8000)
        memory.lastAppliedFields = [...new Set([...(memory.lastAppliedFields ?? []), ...applied])]
        memory.lastConflictingFields = [...new Set([...(memory.lastConflictingFields ?? []), ...conflicts])]
        memory.lastSavedAt = Date.now()
        memory.lastDebugStatus = [
            ...(memory.lastDebugStatus ?? []),
            `First generated image Vision analysis compared the final prompt for ${targets.map(profile => profile.name).join(', ')}; image ${analysisImageId}${imageRecord ? ` (${contentHash.slice(0, 12)})` : ''}.`,
            `${applied.length} previously unknown field(s) applied; ${conflicts.length} conflict(s) preserved.`
        ]
    } catch(error) {
        const reason = error instanceof Error ? error.message : String(error)
        for(const profile of targets) {
            profile.initialImageVisionStatus = 'failed'
            profile.initialImageVisionFailure = reason
        }
        memory.lastAnalysisSource = 'generated-image-vision'
        memory.lastAnalysisResult = `Initial image Vision analysis failed: ${reason}`.slice(0, 8000)
        memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), `First generated image Vision analysis failed: ${reason}; generation and stored image are unchanged.`]
        memory.lastSavedAt = Date.now()
        console.warn('Visual Manager could not analyze the first generated image; image generation and storage are preserved.', error)
    }
}

function filterVisualConflicts(source:Record<string, unknown>, conflicts:string[], prefix:string):Record<string, unknown> {
    const output:Record<string, unknown> = {}
    for(const [key, value] of Object.entries(source)) {
        const path = `${prefix}.${key}`
        if(conflicts.includes(path) || conflicts.includes(key)) continue
        if(value && typeof value === 'object' && !Array.isArray(value)) {
            output[key] = filterVisualConflicts(value as Record<string, unknown>, conflicts, path)
        } else {
            output[key] = value
        }
    }
    return output
}

export function recordVisualImageGenerated(
    char:character,
    chat:Chat,
    imageId:string,
    prompt:string,
    messageId?:string,
    context:VisualPromptContext = {}
):void {
    if(!imageId || !prompt) return
    if(!getVisualSettings(char).enabled) return
    const memory = getChatVisualMemory(chat)
    if(memory.recentImages?.some(image => image.id === imageId)) return
    const assetProfiles = [
        createVisualCharacterProfile(char.chaId, char.name, 'asset'),
        ...(char.visualAssetProfiles ?? [])
    ]
    const characterIds = [...new Set(context.characterIds !== undefined
        ? context.characterIds
        : [
            ...memory.currentCharacterIds,
            ...memory.characters.filter(profile => [profile.name, ...profile.aliases].some(name => matchesName(prompt, name))).map(profile => profile.id),
            ...assetProfiles.filter(profile => [profile.name, ...profile.aliases].some(name => matchesName(prompt, name))).map(profile => profile.id)
        ])]
    const locations = [...(char.visualAssetLocations ?? []), ...memory.locations]
    const locationIds = [...new Set(context.locationIds !== undefined
        ? context.locationIds
        : [
            ...memory.currentLocationIds,
            ...locations.filter(profile => [profile.name, ...profile.aliases].some(name => matchesName(prompt, name))).map(profile => profile.id)
        ])]
    if(messageId && context.sceneSpec) {
        try {
            const sceneData = JSON.parse(context.sceneSpec) as {resolvedCharacters?:Array<{resolvedId?:string; clothingChange?:string}>}
            for(const sceneCharacter of sceneData.resolvedCharacters ?? []) {
                if(sceneCharacter.resolvedId && sceneCharacter.clothingChange?.trim()) {
                    recordVisualStateChange(memory, sceneCharacter.resolvedId, messageId, 'clothing.current', sceneCharacter.clothingChange.trim())
                }
            }
            rebuildChatVisualState(memory, chat)
        } catch(error) {
            console.warn('Visual Manager could not apply the structured scene clothing state.', error)
        }
    }
    const profileVersions:Record<string,string> = {}
    for(const profile of [...assetProfiles, ...memory.characters]) {
        if(characterIds.includes(profile.id)) profileVersions[profile.id] = fingerprint(JSON.stringify(profile))
    }
    memory.recentImages ??= []
    memory.recentImages.push({
        id:imageId,
        generatedAt:Date.now(),
        messageId,
        prompt:prompt.slice(0, 12000),
        characterIds,
        locationIds,
        profileVersions,
        sceneSpec:context.sceneSpec
    })
    if(memory.recentImages.length > 5) memory.recentImages.splice(0, memory.recentImages.length - 5)
    memory.lastGeneratedImageId = imageId
    memory.lastAnalysisSource = 'generated-image'
    memory.lastSavedAt = Date.now()
    if(char.visualManagerSettings?.debug) memory.lastDebugPrompt = prompt
    void extractInitialProfilesFromPrompt(char, chat, imageId, prompt, messageId, context.characterIds ?? []).catch(error => {
        console.warn('Visual Manager could not complete the first-image profile update; image generation is preserved.', error)
        memory.lastDebugStatus = [...(memory.lastDebugStatus ?? []), `Generated image profile extraction failed: ${error instanceof Error ? error.message : String(error)}`]
    })
}

export function setCurrentVisualOutfit(chat:Chat, profileId:string, outfit:string):void {
    const memory = getChatVisualMemory(chat)
    const normalized = outfit.trim()
    if(normalized) {
        memory.currentOutfits[profileId] = normalized
        memory.baseOutfits![profileId] = normalized
    } else {
        delete memory.currentOutfits[profileId]
        delete memory.baseOutfits![profileId]
    }
}
