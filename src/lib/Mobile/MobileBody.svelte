<script lang="ts">
    import { MobileGUIStack, MobileSideBar, selectedCharID, VisualManagerOpen } from "src/ts/stores.svelte";
    import Settings from "../Setting/Settings.svelte";
    import RealmMain from "../UI/Realm/RealmMain.svelte";
    import MobileCharacters from "./MobileCharacters.svelte";
    import ChatScreen from "../ChatScreens/ChatScreen.svelte";
    import CharConfig from "../SideBars/CharConfig.svelte";
    import { WrenchIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import SideChatList from "../SideBars/SideChatList.svelte";
    import DevTool from "../SideBars/DevTool.svelte";
    import VisualManager from "../SideBars/VisualManager.svelte";
    import { isLite } from "src/ts/lite";
    
    import { DBState } from 'src/ts/stores.svelte';
</script>

{#if $MobileSideBar > 0 && !$isLite}
<div class="w-full px-2 py-1 text-textcolor2 border-b border-b-darkborderc bg-darkbg flex justify-start items-center gap-2">
    <button class="flex-1 border-r border-r-darkborderc" class:text-textcolor={$MobileSideBar === 1} onclick={() => {
        $MobileSideBar = 1
    }}>
        {language.Chat}
    </button>
    <button class="flex-1 border-r border-r-darkborderc" class:text-textcolor={$MobileSideBar === 2} onclick={() => {
        $MobileSideBar = 2
    }}>
        {language.character}
    </button>
    {#if $selectedCharID >= 0 && DBState.db.characters[$selectedCharID] && DBState.db.characters[$selectedCharID].type !== 'group' && DBState.db.characters[$selectedCharID].chaId !== '§playground'}
        <button
            class="flex-1 border-r border-r-darkborderc"
            class:text-textcolor={$VisualManagerOpen}
            aria-label={$VisualManagerOpen ? 'Close Visual Manager' : 'Open Visual Manager'}
            aria-expanded={$VisualManagerOpen}
            aria-controls="visual-manager-panel"
            aria-pressed={$VisualManagerOpen}
            onclick={() => VisualManagerOpen.update(open => !open)}
        >
            Visuals
        </button>
    {/if}
    <button class:text-textcolor={$MobileSideBar === 3} onclick={() => {
        $MobileSideBar = 3
    }}>
        <WrenchIcon size={18} />
    </button>
</div>
{/if}
{#if $VisualManagerOpen && $selectedCharID >= 0 && DBState.db.characters[$selectedCharID] && DBState.db.characters[$selectedCharID].type !== 'group' && DBState.db.characters[$selectedCharID].chaId !== '§playground'}
    <div class="fixed inset-0 z-50 bg-black/50" role="dialog" aria-modal="true" aria-label="Visual Manager">
        <button class="absolute inset-0 h-full w-full cursor-default" aria-label="Close Visual Manager" onclick={() => VisualManagerOpen.set(false)}></button>
        <section id="visual-manager-panel" class="absolute inset-y-0 right-0 z-10 flex w-full max-w-xl flex-col bg-bgcolor p-3 shadow-xl">
            <VisualManager char={DBState.db.characters[$selectedCharID]} onClose={() => VisualManagerOpen.set(false)} />
        </section>
    </div>
{/if}
<div class="w-full flex-1 overflow-y-auto bg-bgcolor relative">
    {#if $MobileSideBar > 0}
        <div class="w-full flex flex-col p-2 mt-2 h-full">
            {#if $MobileSideBar === 1}
                <SideChatList bind:chara={DBState.db.characters[$selectedCharID]} />
            {:else if $MobileSideBar === 2}
                <CharConfig />
            {:else if $MobileSideBar === 3}
                <DevTool />
            {/if}
        </div>
    {:else if $selectedCharID !== -1}
        <ChatScreen />
    {:else if $MobileGUIStack === 0}
        <RealmMain />
    {:else if $MobileGUIStack === 1}
        <MobileCharacters />
    {:else if $MobileGUIStack === 2}
        <Settings />
    {/if}
</div>