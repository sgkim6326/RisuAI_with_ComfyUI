import { describe, expect, test } from 'vitest'
import { compileSceneSpecPrompt, parseImgGenSceneSpec } from './visualSceneSpec'

describe('ImgGenJSON scene specification', () => {
    test('validates structured character and scene fields while preserving original-language names', () => {
        const parsed = parseImgGenSceneSpec(JSON.stringify({
            characters:[{
                id:'character-1',
                name:'젬마',
                action:'holding a lantern',
                interaction:'speaking with Alice',
                expression:'gentle smile',
                pose:'standing beside the window',
                clothingChange:'wearing a dark blue coat'
            }],
            scene:{
                location:{id:'library-1', name:'Old Library'},
                background:'tall shelves and arched windows',
                lighting:'warm candlelight',
                camera:'wide composition',
                direction:'quiet reunion'
            }
        }))

        expect(parsed.ok).toBe(true)
        if(!parsed.ok) return
        expect(parsed.value.characters[0].name).toBe('젬마')
        expect(compileSceneSpecPrompt(parsed.value)).toContain('Characters: 젬마 (action: holding a lantern')
        expect(compileSceneSpecPrompt(parsed.value)).toContain('Lighting: warm candlelight')
        expect(compileSceneSpecPrompt(parsed.value)).not.toContain('hair')
    })

    test.each([
        ['missing characters', JSON.stringify({scene:{}})],
        ['missing character identity', JSON.stringify({characters:[{action:'walking'}],scene:{}})],
        ['wrong field type', JSON.stringify({characters:[{name:'Alice',pose:4}],scene:{}})],
        ['too many characters', JSON.stringify({characters:Array.from({length:13},(_,index) => ({name:`Person ${index}`})),scene:{}})]
    ])('rejects invalid scene spec: %s', (_label, source) => {
        expect(parseImgGenSceneSpec(source).ok).toBe(false)
    })
})
