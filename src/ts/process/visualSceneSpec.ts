export interface SceneCharacterInput {
    id?:string
    name?:string
    action?:string
    interaction?:string
    expression?:string
    pose?:string
    clothingChange?:string
}

export interface SceneLocationInput {
    id?:string
    name?:string
}

export interface ImgGenSceneSpec {
    characters:SceneCharacterInput[]
    scene:{
        location?:string|SceneLocationInput
        background?:string
        lighting?:string
        camera?:string
        direction?:string
    }
}

export type SceneSpecParseResult =
    | {ok:true; value:ImgGenSceneSpec}
    | {ok:false; error:string}

function isRecord(value:unknown):value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function optionalText(value:unknown, field:string):string|undefined {
    if(value === undefined || value === null || value === '') return undefined
    if(typeof value !== 'string') throw new Error(`${field} must be a string.`)
    const text = value.trim()
    if(text.length > 2000) throw new Error(`${field} exceeds the 2000 character limit.`)
    return text || undefined
}

function parseCharacter(value:unknown, index:number):SceneCharacterInput {
    if(!isRecord(value)) throw new Error(`characters[${index}] must be an object.`)
    const character:SceneCharacterInput = {
        id:optionalText(value.id, `characters[${index}].id`),
        name:optionalText(value.name, `characters[${index}].name`),
        action:optionalText(value.action, `characters[${index}].action`),
        interaction:optionalText(value.interaction, `characters[${index}].interaction`),
        expression:optionalText(value.expression, `characters[${index}].expression`),
        pose:optionalText(value.pose, `characters[${index}].pose`),
        clothingChange:optionalText(value.clothingChange, `characters[${index}].clothingChange`)
    }
    if(!character.id && !character.name) throw new Error(`characters[${index}] needs a name or stable ID.`)
    return character
}

function parseLocation(value:unknown):string|SceneLocationInput|undefined {
    if(typeof value === 'string') return optionalText(value, 'scene.location')
    if(value === undefined || value === null) return undefined
    if(!isRecord(value)) throw new Error('scene.location must be a string or an object.')
    const location:SceneLocationInput = {
        id:optionalText(value.id, 'scene.location.id'),
        name:optionalText(value.name, 'scene.location.name')
    }
    if(!location.id && !location.name) throw new Error('scene.location needs a name or stable ID.')
    return location
}

export function parseImgGenSceneSpec(source:string):SceneSpecParseResult {
    try {
        const parsed:unknown = JSON.parse(source.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
        if(!isRecord(parsed) || !Array.isArray(parsed.characters) || !isRecord(parsed.scene)) {
            throw new Error('ImgGenJSON must contain a characters array and a scene object.')
        }
        if(parsed.characters.length > 12) throw new Error('ImgGenJSON supports at most 12 characters.')
        const scene:ImgGenSceneSpec['scene'] = {
            location:parseLocation(parsed.scene.location),
            background:optionalText(parsed.scene.background, 'scene.background'),
            lighting:optionalText(parsed.scene.lighting, 'scene.lighting'),
            camera:optionalText(parsed.scene.camera, 'scene.camera'),
            direction:optionalText(parsed.scene.direction, 'scene.direction')
        }
        return {
            ok:true,
            value:{
                characters:parsed.characters.map(parseCharacter),
                scene
            }
        }
    } catch(error) {
        return { ok:false, error:error instanceof Error ? error.message : String(error) }
    }
}

export function compileSceneSpecPrompt(spec:ImgGenSceneSpec):string {
    const characterLines = spec.characters.map(character => {
        const identifier = character.name ?? character.id!
        const details = [
            character.action && `action: ${character.action}`,
            character.interaction && `interaction: ${character.interaction}`,
            character.expression && `expression: ${character.expression}`,
            character.pose && `pose: ${character.pose}`,
            character.clothingChange && `current clothing change: ${character.clothingChange}`
        ].filter(Boolean)
        return `${identifier}${details.length ? ` (${details.join('; ')})` : ''}`
    })
    const location = typeof spec.scene.location === 'string'
        ? spec.scene.location
        : spec.scene.location?.name ?? spec.scene.location?.id
    const sceneLines = [
        location && `Setting: ${location}`,
        spec.scene.background && `Background: ${spec.scene.background}`,
        spec.scene.lighting && `Lighting: ${spec.scene.lighting}`,
        spec.scene.camera && `Camera composition: ${spec.scene.camera}`,
        spec.scene.direction && `Scene direction: ${spec.scene.direction}`
    ].filter(Boolean)
    return [
        characterLines.length ? `Characters: ${characterLines.join('; ')}.` : '',
        ...sceneLines
    ].filter(Boolean).join(' ')
}
