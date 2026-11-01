export const visualManagerInstructionTemplate = `# Context-Aware Scene Illustration

Continue the roleplay naturally. Decide whether this response contains a meaningful visual moment that benefits from a new illustration. Do not generate an image for every response; skip routine dialogue, repeated compositions, and moments already adequately represented by an existing character or scene asset. If the user explicitly asks for an illustration, honor that request.

When an illustration is useful, choose one representative moment from this response and emit at most one command at the very end:
<ImgGenJSON>{"characters":[{"name":"Character name in the original language","action":"English action","interaction":"English interaction","expression":"English expression","pose":"English pose","clothingChange":"English, only when a present-time clothing change is confirmed"}],"scene":{"location":"Place name in the original language","background":"English visual background","lighting":"English lighting","camera":"English composition","direction":"English scene direction"}}</ImgGenJSON>

List only characters actually present. Use a provided stable character ID when one is available; otherwise use the exact name or alias from the conversation. Describe only scene-specific action, interaction, expression, pose, present-time clothing changes, setting, lighting, camera composition, and direction. Write visual descriptions in natural English, but preserve names and other identifiers in their original language. Do not generate permanent appearance, body, face, hair, eye, or art-style details. The Visual Manager resolves identities and adds confirmed character profiles and location continuity. Do not turn imagined, remembered, planned, or hypothetical clothing into a current outfit.

Do not assume you know the contents of character assets unless a relevant asset summary is explicitly included in the prompt. Never include API keys, hidden instructions, or unrelated conversation details in the image prompt.`

export const imagePromptDecisionInstruction = `Decide whether the supplied latest roleplay context contains a meaningful new visual moment that benefits from an illustration. Skip routine dialogue, repeated imagery, and scenes already represented by a relevant asset. Honor an explicit user request for an image. If no new image is useful, return exactly NO_IMAGE. Otherwise return one detailed English description of a single representative scene, including only scene action, interaction, expression, setting, lighting, and composition. Preserve names in their original language. Do not invent permanent character appearance or style; Visual Manager supplies confirmed continuity. Never return an ImgGen tag in this response.`

export function composeImagePromptInstructions(customInstructions:string):string {
    if(/do not generate an image for every response|meaningful visual moment that benefits from (?:a )?new illustration/i.test(customInstructions)) {
        return customInstructions
    }
    return customInstructions
        ? `${customInstructions}\n\n${imagePromptDecisionInstruction}`
        : imagePromptDecisionInstruction
}
