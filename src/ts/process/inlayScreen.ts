import { writeInlayImage } from "./files/inlays";
import type { Chat, character } from "../storage/database.svelte";
import { generateAIImage } from "./stableDiff";
import { imagePromptDecisionInstruction, visualManagerInstructionTemplate } from "./visualPromptInstructions";
import { recordVisualImageDecision, recordVisualImageGenerated, resolveVisualSceneReferences } from "./visualManager";
import type { VisualPromptContext } from "./visualManager";
import { compileSceneSpecPrompt, parseImgGenSceneSpec } from "./visualSceneSpec";

const imggenRegex = [/<ImgGen="(.+?)">/gi, /{{ImgGen="(.+?)"}}/gi] as const
const imggenJsonRegex = /<ImgGenJSON>([\s\S]*?)<\/ImgGenJSON>/gi

type ParsedImageCommand = {command:string; prompt:string; index:number; scene?:ReturnType<typeof parseImgGenSceneSpec>}

function firstImageCommand(data:string):ParsedImageCommand|undefined {
    const commands:ParsedImageCommand[] = []
    imggenJsonRegex.lastIndex = 0
    for(const match of data.matchAll(imggenJsonRegex)) {
        commands.push({
            command:match[0],
            prompt:match[1],
            index:match.index ?? 0,
            scene:parseImgGenSceneSpec(match[1])
        })
    }
    for(const regex of imggenRegex) {
        regex.lastIndex = 0
        for(const match of data.matchAll(regex)) {
            commands.push({ command:match[0], prompt:match[1], index:match.index ?? 0 })
        }
    }
    return commands.sort((a, b) => a.index - b.index)[0]
}

function stripImageCommands(data:string, selectedCommand?:string):string {
    let placeholderInserted = false
    const strip = (match:string) => {
        if(selectedCommand && !placeholderInserted && match === selectedCommand) {
            placeholderInserted = true
            return '[Generating...]'
        }
        return ''
    }
    return data
        .replace(imggenJsonRegex, strip)
        .replace(imggenRegex[0], strip)
        .replace(imggenRegex[1], strip)
}

export function runInlayScreen(
    char:character,
    data:string,
    context:{chat?:Chat; messageId?:string; visualUpdate?:Promise<void>} = {}
):{text:string, promise?:Promise<string>} {
    if(char.inlayViewScreen){      
        if(char.viewScreen === 'emotion'){
            return {text: data.replace(/<Emotion="(.+?)">/gi, '{{emotion::$1}}')}
        }
        if(char.viewScreen === 'imggen'){
            let selected = firstImageCommand(data)
            if(!selected) return {text:data}
            if(selected.scene?.ok === false) {
                recordVisualImageDecision(char, `ImgGenJSON was not generated because validation failed: ${selected.scene.error}`)
                selected = firstImageCommand(data.replace(selected.command, ''))
                if(!selected) return {text:stripImageCommands(data)}
            }
            const selectedCommand = selected.command
            const visibleText = stripImageCommands(data, selectedCommand)
            return {
                text: visibleText,
                promise : (async () => {
                    await context.visualUpdate?.catch(error => {
                        console.warn('Visual Manager response analysis failed before image generation; continuing without new analysis.', error)
                    })
                    const chat = context.chat ?? char.chats?.[char.chatPage]
                    let visualContext:VisualPromptContext|undefined
                    const scenePrompt = selected.scene?.ok
                        ? compileSceneSpecPrompt(selected.scene.value)
                        : selected.prompt
                    if(selected.scene?.ok && chat) {
                        visualContext = resolveVisualSceneReferences(char, chat, selected.scene.value)
                    }
                    const prompt = char.newGenData.prompt.replaceAll('{{slot}}', scenePrompt)
                    let finalPrompt = prompt
                    const generated = await generateAIImage(prompt, char, char.newGenData.negative, 'inlay', {
                        visualContext,
                        onPromptPrepared:prepared => { finalPrompt = prepared }
                    })
                    let replacement = ''
                    if(generated) {
                        const imgHTML = new Image()
                        imgHTML.src = generated
                        const inlay = await writeInlayImage(imgHTML)
                        if(chat && visualContext) {
                            recordVisualImageGenerated(char, chat, inlay, finalPrompt, context.messageId, visualContext)
                        } else if(chat) {
                            recordVisualImageGenerated(char, chat, inlay, finalPrompt, context.messageId)
                        }
                        replacement = `{{inlay::${inlay}}}`
                    }
                    const output = data.replace(selectedCommand, replacement)
                    return output.replace(imggenRegex[0], '').replace(imggenRegex[1], '')
                })()
            }
        }
        
    }

    return {text: data}
}

export function updateInlayScreen(char:character):character {
    const previous = char.newGenData
    const previousInstructions = previous?.instructions ?? ''
    const legacyDefaults = [
        'You must always output the character\'s image as a keyword-formatted prompts that can be used in stable diffusion  at the end of a conversation. Use one image, depending on character, place, situation, etc. keyword should be long enough. Form: <ImgGen="<keyword-formatted prompt>">',
        'You must always output the character\'s image as a keyword-formatted prompts that can be used in stable diffusion. only output the that prompt, depending on character, place, situation, etc. keyword should be long enough.'
    ]
    const preservedInstructions = legacyDefaults.includes(previousInstructions) ? '' : previousInstructions
    const setData = (defaults:NonNullable<character['newGenData']>) => {
        char.newGenData = {
            ...defaults,
            ...previous,
            instructions:preservedInstructions || defaults.instructions
        }
        return char
    }
    switch(char.viewScreen){
        case 'emotion':
            if(char.inlayViewScreen){
                return setData({
                    prompt: '',
                    negative: '',
                    instructions: '',
                    emotionInstructions: `You must always output the character's emotional image as a command at the end of a conversation. The command must be selected from a given list, and it's better to have variety than to repeat images used in previous chats. Use one image, depending on the character's emotion. See the list below. Form: <Emotion="<image command>"> Example: <Emotion="Agree"> List of commands: {{slot}}`,
                })
            }
            return setData({
                prompt: '',
                negative: '',
                instructions: '',
                emotionInstructions: `You must always output the character's emotional image as a command. The command must be selected from a given list, only output the command, depending on the character's emotion. List of commands: {{slot}}`
            })
        case 'imggen':
            if(char.inlayViewScreen){
                return setData({
                    prompt: 'best quality, {{slot}}',
                    negative: 'worse quality',
                    instructions: visualManagerInstructionTemplate,
                    emotionInstructions: ''
                })
            }
            return setData({
                prompt: 'best quality, {{slot}}',
                negative: 'worse quality',
                instructions: imagePromptDecisionInstruction,
                emotionInstructions: ''
            })
        default:
            return setData({
                prompt: '',
                negative: '',
                instructions: '',
                emotionInstructions: ''
            })
    }
}