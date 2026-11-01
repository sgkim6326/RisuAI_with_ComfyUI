<script lang="ts">
    import { v4 } from 'uuid'
    import {
        createVisualCharacterProfile,
        createVisualLocationProfile,
        getChatVisualMemory,
        getVisualCharacterAssets,
        getVisualSettings,
        getVisualLorebookCatalog,
        analyzeVisualAssetIfNeeded,
        analyzeVisualMemory,
        setCurrentVisualOutfit,
        updateManualVisualField
    } from '../../ts/process/visualManager'
    import { updateInlayScreen } from '../../ts/process/inlayScreen'
    import type { character, Chat, ChatVisualMemory, VisualCharacterProfile, VisualLocationProfile, VisualManagerSettings } from '../../ts/storage/database.svelte'

    interface Props {
        char:character
        onClose?:() => void
    }

    let { char, onClose = () => {} }:Props = $props()
    let section = $state<'Characters'|'Locations'|'Settings'>('Characters')
    let search = $state('')
    let selectedCharacterId = $state('')
    let selectedLocationId = $state('')
    let chat = $derived(char.chats?.[char.chatPage] as Chat | undefined)
    let memory = $state<ChatVisualMemory>()
    let settings = $state<VisualManagerSettings>({
        enabled:true,
        autoAnalyze:true,
        maxCharacters:20,
        maxLocations:10,
        recentMessages:50,
        debug:false
    })
    let visualAssets = $derived(getVisualCharacterAssets(char))

    $effect(() => {
        const nextSettings = getVisualSettings(char)
        if(settings !== nextSettings) settings = nextSettings
        const currentChat = chat
        const nextMemory = currentChat ? getChatVisualMemory(currentChat) : undefined
        if(memory !== nextMemory) memory = nextMemory
    })

    const characterFields = [
        { name:'Style', fields:[
            ['style.medium','Medium'], ['style.artStyle','Art style'], ['style.lineArt','Line art'],
            ['style.shading','Shading'], ['style.colorPalette','Color palette'], ['style.additional','Additional']
        ]},
        { name:'Face', fields:[['face.shape','Shape'], ['face.features','Features']]},
        { name:'Eyes', fields:[['eye.color','Color'], ['eye.shape','Shape'], ['eye.details','Details']]},
        { name:'Hair', fields:[['hair.color','Color'], ['hair.length','Length'], ['hair.style','Style'], ['hair.details','Details']]},
        { name:'Body', fields:[
            ['body.build','Build'], ['body.skin','Skin'], ['body.proportions','Proportions'], ['body.distinctiveFeatures','Distinctive features']
        ]}
    ] as const
    const locationFields = [
        ['structure','Structure'], ['interior','Interior'], ['lighting','Lighting'], ['colorPalette','Color palette'], ['atmosphere','Atmosphere']
    ] as const

    let assetCharacters = $derived([
        {
            id:char.chaId,
            name:char.name,
            aliases:[char.nickname ?? ''].filter(Boolean),
            source:'asset' as const,
            sourceLabel:char.imported ? 'Imported character' : 'Character asset'
        },
        ...(char.visualAssetProfiles ?? [])
            .filter(profile => profile.id !== char.chaId)
            .map(profile => ({...profile, sourceLabel:'Linked asset'}))
    ])
    let memoryCharacters = $derived(memory?.characters ?? [])
    let visibleCharacters = $derived([
        ...assetCharacters,
        ...memoryCharacters.map(profile => ({...profile, sourceLabel:'Visual Memory'}))
    ].filter(profile => {
        const query = search.trim().toLocaleLowerCase()
        return !query || [profile.name, ...profile.aliases].some(value => value.toLocaleLowerCase().includes(query))
    }))
    let lorebookLocations = $derived(chat
        ? getVisualLorebookCatalog(char, chat).map(profile => ({...profile, sourceLabel:'Lorebook'}))
        : [])
    let visibleLocations = $derived([
        ...lorebookLocations,
        ...(memory?.locations ?? []).map(profile => ({...profile, sourceLabel:'Visual Memory'}))
    ].filter(profile => {
        const query = search.trim().toLocaleLowerCase()
        return !query || [profile.name, ...profile.aliases].some(value => value.toLocaleLowerCase().includes(query))
    }))

    $effect(() => {
        if(!visibleCharacters.some(profile => profile.id === selectedCharacterId)) {
            selectedCharacterId = visibleCharacters[0]?.id ?? ''
        }
        if(!visibleLocations.some(profile => profile.id === selectedLocationId)) {
            selectedLocationId = visibleLocations[0]?.id ?? ''
        }
    })

    function selectedCharacter():VisualCharacterProfile|undefined {
        if(!memory) return
        const saved = memory.characters.find(profile => profile.id === selectedCharacterId)
            ?? char.visualAssetProfiles?.find(profile => profile.id === selectedCharacterId)
        if(saved) return saved
        const asset = assetCharacters.find(profile => profile.id === selectedCharacterId)
        if(!asset) return undefined
        const profile = createVisualCharacterProfile(asset.id, asset.name, 'asset')
        profile.aliases = asset.aliases
        if(asset.id === char.chaId && char.image) {
            profile.assetUri = char.image
            profile.assetName = char.name
        }
        return profile
    }

    function editableCharacter():VisualCharacterProfile|undefined {
        const profile = selectedCharacter()
        if(!profile || profile.source === 'memory') return profile
        char.visualAssetProfiles ??= []
        let saved = char.visualAssetProfiles.find(item => item.id === profile.id)
        if(!saved) {
            saved = profile
            char.visualAssetProfiles.push(saved)
        }
        return saved
    }

    function selectedLocation():VisualLocationProfile|undefined {
        if(!memory) return
        const saved = memory.locations.find(profile => profile.id === selectedLocationId)
            ?? char.visualAssetLocations?.find(profile => profile.id === selectedLocationId)
        if(saved) return saved
        const lorebook = lorebookLocations.find(profile => profile.id === selectedLocationId)
        if(!lorebook) return undefined
        const profile = createVisualLocationProfile(lorebook.id, lorebook.name, 'lorebook')
        profile.aliases = lorebook.aliases
        return profile
    }

    function editableLocation():VisualLocationProfile|undefined {
        const profile = selectedLocation()
        if(!profile || profile.source === 'memory') return profile
        char.visualAssetLocations ??= []
        let saved = char.visualAssetLocations.find(item => item.id === profile.id)
        if(!saved) {
            saved = profile
            char.visualAssetLocations.push(saved)
        }
        return saved
    }

    function fieldValue(profile:VisualCharacterProfile|undefined, path:string):string {
        if(!profile) return ''
        const value = path.split('.').reduce<unknown>((current, key) =>
            current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, profile)
        return typeof value === 'string' ? value : ''
    }

    function setCharacterField(path:string, value:string):void {
        const profile = editableCharacter()
        if(profile) updateManualVisualField(profile, path, value)
    }

    function setLocationField(path:string, value:string):void {
        const profile = editableLocation()
        if(profile) updateManualVisualField(profile, path, value)
    }

    function addCharacter():void {
        if(!memory || memory.characters.length >= settings.maxCharacters) return
        const id = v4()
        const profile = createVisualCharacterProfile(id, 'New character')
        memory.characters.push(profile)
        selectedCharacterId = id
    }

    function addAssetProfile():void {
        const id = v4()
        char.visualAssetProfiles ??= []
        const profile = createVisualCharacterProfile(id, 'New linked character', 'asset')
        char.visualAssetProfiles.push(profile)
        selectedCharacterId = id
    }

    function addLocation():void {
        if(!memory || memory.locations.length >= settings.maxLocations) return
        const id = v4()
        const profile = createVisualLocationProfile(id, 'New location')
        memory.locations.push(profile)
        selectedLocationId = id
    }

    function setAliases(profile:VisualCharacterProfile|VisualLocationProfile, value:string):void {
        profile.aliases = [...new Set(value.split(',').map(alias => alias.trim()).filter(Boolean))]
        profile.manualFields ??= []
        if(!profile.manualFields.includes('aliases')) profile.manualFields.push('aliases')
    }

    function setOutfit(profile:VisualCharacterProfile|undefined, outfit:string):void {
        if(chat && profile) setCurrentVisualOutfit(chat, profile.id, outfit)
    }

    function addPreset(profile:VisualCharacterProfile):void {
        const id = v4()
        profile.clothing.presets[id] = { name:'New outfit', description:'' }
        profile.clothing.defaultPreset = id
    }

    async function linkVisualAsset(profile:VisualCharacterProfile, uri:string):Promise<void> {
        const asset = visualAssets.find(item => item.uri === uri)
        profile.assetUri = asset?.uri
        profile.assetName = asset?.name
        profile.assetKind = asset?.kind
        profile.assetContentHash = undefined
        profile.visionAnalysisStatus = undefined
        profile.visionModel = undefined
        profile.visionFailure = undefined
        if(asset) await analyzeVisualAssetIfNeeded(char, profile)
    }

    async function reanalyzeVisualAsset(profile:VisualCharacterProfile):Promise<void> {
        profile.visionAnalysisStatus = undefined
        profile.visionModel = undefined
        await analyzeVisualAssetIfNeeded(char, profile, true)
    }

    async function retryChatAnalysis():Promise<void> {
        if(chat) await analyzeVisualMemory(char, chat, undefined, true)
    }

    function applyRecommendedImageSetup():void {
        char.viewScreen = 'imggen'
        char.inlayViewScreen = true
        updateInlayScreen(char)
    }
</script>

<div class="flex h-full min-h-0 flex-col gap-3 overflow-hidden text-textcolor">
    <div class="flex items-center justify-between border-b border-borderc pb-2">
        <h2 class="text-lg font-semibold">Visual Manager</h2>
        <button class="rounded-md px-2 py-1 text-textcolor2 hover:bg-darkbutton hover:text-textcolor" aria-label="Close Visual Manager" onclick={onClose}>Close</button>
    </div>
    <div class="flex shrink-0 gap-1" role="tablist" aria-label="Visual Manager sections">
        {#each ['Characters','Locations','Settings'] as tab}
            <button class="grow rounded-md bg-darkbutton px-2 py-2 text-sm" class:bg-selected={section === tab} role="tab" aria-selected={section === tab} onclick={() => section = tab as typeof section}>
                {tab}
            </button>
        {/each}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
    {#if section === 'Characters'}
        <div class="flex gap-2">
            <input class="min-w-0 grow rounded-md border border-borderc bg-bgcolor p-2" placeholder="Search name or alias" bind:value={search}/>
            <button class="rounded-md bg-darkbutton px-2" onclick={addAssetProfile}>+ Asset</button>
            <button class="rounded-md bg-darkbutton px-2" onclick={addCharacter} disabled={!memory || memory.characters.length >= settings.maxCharacters}>+ Memory</button>
        </div>
        <div class="text-xs text-textcolor2">CHARX assets do not use the Visual Memory limit. New entries: {memory?.characters.length ?? 0}/{settings.maxCharacters}</div>
        <div class="flex gap-2">
            <div class="flex w-2/5 min-w-28 flex-col gap-1">
                {#each visibleCharacters as item (item.id)}
                    <button class="rounded-md bg-bgcolor p-2 text-left text-sm" class:bg-selected={selectedCharacterId === item.id} onclick={() => selectedCharacterId = item.id}>
                        <div class="truncate">{item.name}</div>
                        <div class="text-xs text-textcolor2">{item.sourceLabel}</div>
                    </button>
                {/each}
            </div>
            {#if selectedCharacter()}
                {@const profile = selectedCharacter()!}
                <div class="flex min-w-0 grow flex-col gap-3">
                    <div class="flex items-center gap-2">
                        <input class="min-w-0 grow rounded-md border border-borderc bg-bgcolor p-2" value={profile.name} oninput={(event) => {
                            const target = editableCharacter()
                            if(target) updateManualVisualField(target, 'name', event.currentTarget.value)
                        }}/>
                        <span class="rounded bg-bgcolor px-2 py-1 text-xs">{profile.source === 'asset' ? 'Asset' : 'Memory'}</span>
                    </div>
                    <label class="text-xs">Aliases (comma separated)
                        <input class="mt-1 w-full rounded-md border border-borderc bg-bgcolor p-2" value={profile.aliases.join(', ')} oninput={(event) => {
                            const target = editableCharacter()
                            if(target) setAliases(target, event.currentTarget.value)
                        }}/>
                    </label>
                    <section class="rounded-md border border-borderc p-2">
                        <label class="text-xs">Linked CHARX image asset
                            <select class="mt-1 w-full rounded-md border border-borderc bg-bgcolor p-2" value={profile.assetUri ?? ''} onchange={(event) => linkVisualAsset(profile, event.currentTarget.value)}>
                                <option value="">No linked image</option>
                                {#each visualAssets as asset}
                                    <option value={asset.uri}>{asset.name}</option>
                                {/each}
                            </select>
                        </label>
                        {#if profile.visionAnalysisStatus === 'complete'}
                            <div class="mt-2 text-xs text-textcolor2">Vision profile cached ({profile.assetKind ?? 'linked'}, {profile.visionModel}) · hash {profile.assetContentHash?.slice(0, 12)} · {profile.assetUri}</div>
                        {:else if profile.visionAnalysisStatus === 'unavailable' || profile.visionAnalysisStatus === 'failed'}
                            <div class="mt-2 text-xs text-textcolor2">{profile.visionFailure}</div>
                        {/if}
                        {#if settings.debug && profile.initialImageVisionStatus}
                            <div class="mt-2 text-xs text-textcolor2">
                                First generated image: {profile.initialImageVisionStatus} · {profile.initialImageVisionModel} ·
                                {profile.initialImageContentHash?.slice(0, 12) ?? profile.initialImageReferenceId}
                                {#if profile.initialImageVisionFailure}<div>{profile.initialImageVisionFailure}</div>{/if}
                            </div>
                        {/if}
                        {#if profile.assetUri}
                            <button class="mt-2 rounded bg-darkbutton px-2 py-1 text-xs" onclick={() => reanalyzeVisualAsset(profile)}>Analyze image now</button>
                        {/if}
                    </section>
                    {#each characterFields as group}
                        <details class="rounded-md border border-borderc p-2">
                            <summary class="cursor-pointer text-sm font-semibold">{group.name}</summary>
                            <div class="flex flex-col gap-2">
                                {#each group.fields as [path, label]}
                                    <label class="text-xs">{label}
                                        <textarea class="mt-1 min-h-14 w-full rounded-md border border-borderc bg-bgcolor p-2 text-sm" value={fieldValue(profile, path)} oninput={(event) => setCharacterField(path, event.currentTarget.value)}></textarea>
                                    </label>
                                {/each}
                            </div>
                        </details>
                    {/each}
                    <section class="rounded-md border border-borderc p-2">
                        <div class="mb-2 flex items-center justify-between">
                            <h3 class="text-sm font-semibold">Clothing presets</h3>
                            <button class="rounded bg-darkbutton px-2 py-1 text-xs" onclick={() => {
                                const target = editableCharacter()
                                if(target) addPreset(target)
                            }}>+ Preset</button>
                        </div>
                        <label class="mb-2 block text-xs">Default preset
                            <select class="mt-1 w-full rounded-md border border-borderc bg-bgcolor p-2" value={profile.clothing.defaultPreset} onchange={(event) => {
                                const target = editableCharacter()
                                if(target) updateManualVisualField(target, 'clothing.defaultPreset', event.currentTarget.value)
                            }}>
                                {#each Object.entries(profile.clothing.presets) as [id, preset]}
                                    <option value={id}>{preset.name}</option>
                                {/each}
                            </select>
                        </label>
                        {#each Object.entries(profile.clothing.presets) as [id, preset]}
                            <div class="mb-2 rounded bg-bgcolor p-2">
                                <input class="mb-1 w-full rounded border border-borderc bg-bgcolor p-2 text-sm" value={preset.name} oninput={(event) => {
                                    const target = editableCharacter()
                                    if(target?.clothing.presets[id]) updateManualVisualField(target, `clothing.presets.${id}.name`, event.currentTarget.value)
                                }}/>
                                <textarea class="min-h-14 w-full rounded border border-borderc bg-bgcolor p-2 text-sm" placeholder="Outfit description" value={preset.description} oninput={(event) => {
                                    const target = editableCharacter()
                                    if(target?.clothing.presets[id]) updateManualVisualField(target, `clothing.presets.${id}.description`, event.currentTarget.value)
                                }}></textarea>
                                {#if Object.keys(profile.clothing.presets).length > 1}
                                    <button class="mt-1 text-xs text-draculared" onclick={() => {
                                        const target = editableCharacter()
                                        if(!target) return
                                        delete target.clothing.presets[id]
                                        if(target.clothing.defaultPreset === id) target.clothing.defaultPreset = Object.keys(target.clothing.presets)[0] ?? ''
                                    }}>Delete preset</button>
                                {/if}
                            </div>
                        {/each}
                    </section>
                    <label class="text-xs">Current outfit in this chat
                        <textarea class="mt-1 min-h-14 w-full rounded-md border border-borderc bg-bgcolor p-2 text-sm" value={memory?.currentOutfits[profile.id] ?? ''} oninput={(event) => setOutfit(profile, event.currentTarget.value)}></textarea>
                    </label>
                    <div class="flex gap-2">
                        {#if profile.source === 'memory'}
                            <button class="grow rounded-md bg-darkbutton p-2" onclick={() => profile.pinned = !profile.pinned}>{profile.pinned ? 'Unpin' : 'Pin'}</button>
                            <button class="grow rounded-md bg-darkbutton p-2 text-draculared" onclick={() => {
                                if(memory) memory.characters = memory.characters.filter(item => item.id !== profile.id)
                                if(memory) delete memory.currentOutfits[profile.id]
                                selectedCharacterId = ''
                            }}>Delete</button>
                        {:else if profile.id !== char.chaId}
                            <button class="grow rounded-md bg-darkbutton p-2 text-draculared" onclick={() => {
                                char.visualAssetProfiles = char.visualAssetProfiles?.filter(item => item.id !== profile.id)
                                selectedCharacterId = ''
                            }}>Delete linked profile</button>
                        {/if}
                    </div>
                </div>
            {/if}
        </div>
    {:else if section === 'Locations'}
        <div class="flex gap-2">
            <input class="min-w-0 grow rounded-md border border-borderc bg-bgcolor p-2" placeholder="Search location" bind:value={search}/>
            <button class="rounded-md bg-darkbutton px-3" onclick={addLocation} disabled={!memory || memory.locations.length >= settings.maxLocations}>+ New</button>
        </div>
        <div class="text-xs text-textcolor2">Lorebook locations do not use the Visual Memory limit. New entries: {memory?.locations.length ?? 0}/{settings.maxLocations}</div>
        <div class="flex gap-2">
            <div class="flex w-2/5 min-w-28 flex-col gap-1">
                {#each visibleLocations as item (item.id)}
                    <button class="rounded-md bg-bgcolor p-2 text-left text-sm" class:bg-selected={selectedLocationId === item.id} onclick={() => selectedLocationId = item.id}>
                        <div class="truncate">{item.name}</div>
                        <div class="text-xs text-textcolor2">{item.sourceLabel}</div>
                    </button>
                {/each}
            </div>
            {#if selectedLocation()}
                {@const profile = selectedLocation()!}
                <div class="flex min-w-0 grow flex-col gap-3">
                    <input class="w-full rounded-md border border-borderc bg-bgcolor p-2" value={profile.name} oninput={(event) => {
                        const target = editableLocation()
                        if(target) updateManualVisualField(target, 'name', event.currentTarget.value)
                    }}/>
                    <label class="text-xs">Aliases (comma separated)
                        <input class="mt-1 w-full rounded-md border border-borderc bg-bgcolor p-2" value={profile.aliases.join(', ')} oninput={(event) => {
                            const target = editableLocation()
                            if(target) setAliases(target, event.currentTarget.value)
                        }}/>
                    </label>
                    {#each locationFields as [path, label]}
                        <label class="text-xs">{label}
                            <textarea class="mt-1 min-h-16 w-full rounded-md border border-borderc bg-bgcolor p-2 text-sm" value={profile[path]} oninput={(event) => setLocationField(path, event.currentTarget.value)}></textarea>
                        </label>
                    {/each}
                    {#if profile.source === 'memory'}
                        <div class="flex gap-2">
                            <button class="grow rounded-md bg-darkbutton p-2" onclick={() => profile.pinned = !profile.pinned}>{profile.pinned ? 'Unpin' : 'Pin'}</button>
                            <button class="grow rounded-md bg-darkbutton p-2 text-draculared" onclick={() => {
                                if(memory) memory.locations = memory.locations.filter(item => item.id !== profile.id)
                                selectedLocationId = ''
                            }}>Delete</button>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    {:else}
        <section class="flex flex-col gap-3 rounded-md border border-borderc p-3">
            <label class="flex items-center justify-between gap-3">Visual Memory enabled
                <input type="checkbox" bind:checked={settings.enabled}/>
            </label>
            <label class="flex items-center justify-between gap-3">Automatic analysis
                <input type="checkbox" bind:checked={settings.autoAnalyze}/>
            </label>
            <label class="flex items-center justify-between gap-3">Maximum new characters
                <input class="w-20 rounded border border-borderc bg-bgcolor p-1" type="number" min="0" max="200" bind:value={settings.maxCharacters}/>
            </label>
            <label class="flex items-center justify-between gap-3">Maximum new locations
                <input class="w-20 rounded border border-borderc bg-bgcolor p-1" type="number" min="0" max="100" bind:value={settings.maxLocations}/>
            </label>
            <label class="flex items-center justify-between gap-3">Recent messages to analyze
                <input class="w-20 rounded border border-borderc bg-bgcolor p-1" type="number" min="1" max="500" bind:value={settings.recentMessages}/>
            </label>
            <label class="flex items-center justify-between gap-3">Debug prompt and analysis
                <input type="checkbox" bind:checked={settings.debug}/>
            </label>
        </section>
        <section class="rounded-md border border-borderc p-3">
            <h3 class="mb-2 font-semibold">Image generation setup</h3>
            <p class="mb-2 text-xs text-textcolor2">Applying this sets imggen and inlay mode for this character. Existing setup is not changed automatically.</p>
            <button class="rounded-md bg-darkbutton px-3 py-2 text-sm" onclick={applyRecommendedImageSetup}>Apply recommended image settings</button>
        </section>
        {#if settings.debug}
            <section class="rounded-md border border-borderc p-2 text-xs">
                <h3 class="font-semibold">Last pipeline update</h3>
                <div>Source: {memory?.lastAnalysisSource ?? 'none'}</div>
                <div>Related messages: {memory?.lastRelatedMessageIds?.join(', ') || 'none'}</div>
                <div>Last saved: {memory?.lastSavedAt ? new Date(memory.lastSavedAt).toLocaleString() : 'never'}</div>
                <div>Applied fields: {memory?.lastAppliedFields?.join(', ') || 'none'}</div>
                <div>Preserved conflicts: {memory?.lastConflictingFields?.join(', ') || 'none'}</div>
                <div>Analysis model: {memory?.lastAnalysisModel ?? 'unknown'} · {memory?.lastAnalysisProvider ?? 'unknown provider'} · {memory?.lastAnalysisFailureKind ?? 'no failure'}</div>
                {#if memory?.lastVisualTranslationModel}
                    <div>Visual translation model: {memory.lastVisualTranslationModel} · {memory.lastVisualTranslationProvider ?? 'unknown provider'} · {memory.lastVisualTranslationFailureKind ?? 'no failure'}</div>
                {/if}
                <button class="mt-2 rounded bg-darkbutton px-2 py-1 text-xs" onclick={retryChatAnalysis}>Retry chat analysis</button>
                {#if memory?.lastAnalysisMetrics}
                    <div class="mt-1">
                        Cost: {memory.lastAnalysisMetrics.elapsedMs} ms · {memory.lastAnalysisMetrics.assetMetadataCount} asset metadata entries ·
                        {memory.lastAnalysisMetrics.imageBytesRead} image bytes · {memory.lastAnalysisMetrics.visionCalls} Vision calls ·
                        {memory.lastAnalysisMetrics.llmCalls} LLM calls · {memory.lastAnalysisMetrics.cacheHits} cache hits
                    </div>
                {/if}
            </section>
            {#if memory?.lastDebugStatus?.length}
                <details open class="rounded-md border border-borderc p-2">
                    <summary class="cursor-pointer">Visual resolution and diagnostics</summary>
                    <ul class="mt-2 list-inside list-disc space-y-1 text-xs">
                        {#each memory.lastDebugStatus as status}
                            <li class="break-words">{status}</li>
                        {/each}
                    </ul>
                </details>
            {/if}
            {#if memory?.lastAnalysisResult}
                <details class="rounded-md border border-borderc p-2">
                    <summary class="cursor-pointer">Last analysis response</summary>
                    <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{memory.lastAnalysisResult}</pre>
                </details>
            {/if}
            {#if memory?.lastDebugPrompt}
                <details class="rounded-md border border-borderc p-2">
                    <summary class="cursor-pointer">Last final image prompt</summary>
                    <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{memory.lastDebugPrompt}</pre>
                </details>
            {/if}
            {#if memory?.lastDebugSceneSpec}
                <details class="rounded-md border border-borderc p-2">
                    <summary class="cursor-pointer">Last resolved SceneSpec JSON</summary>
                    <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{memory.lastDebugSceneSpec}</pre>
                </details>
            {/if}
            {#if memory?.recentImages?.length}
                <details class="rounded-md border border-borderc p-2">
                    <summary class="cursor-pointer">Recent generated images (up to 5)</summary>
                    <div class="mt-2 flex flex-col gap-2">
                        {#each [...memory.recentImages].reverse() as image (image.id)}
                            <details class="rounded border border-borderc p-2">
                                <summary>{new Date(image.generatedAt).toLocaleString()} · {image.id} · {image.characterIds.join(', ') || 'unresolved character'}</summary>
                                <div>Message: {image.messageId ?? 'unknown'}</div>
                                <div>Locations: {image.locationIds.join(', ') || 'none'}</div>
                                <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{image.prompt}</pre>
                            </details>
                        {/each}
                    </div>
                </details>
            {/if}
        {/if}
    {/if}
</div>
</div>
