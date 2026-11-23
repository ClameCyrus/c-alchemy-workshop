import { watch } from 'vue';

type Character = { avatar: string; chat: string; shallow?: boolean };
type ChatLoaded = { detail?: { id?: number | string; character?: Character } };
const recentRow = '#chat > .welcomePanel .recentChatList > .recentChat[data-avatar][data-file]';
const loadModule = (path: string) => import(/* webpackIgnore: true */ new URL(path, location.href).href);

export function installNativeRecentChat(enabled: () => boolean) {
  let opening = false;
  const unconfirmed = new WeakMap<Character, string>();
  return watch(enabled, (on, _, cleanup) => {
    if (!on) return;
    const controller = new AbortController();
    const { signal } = controller;
    cleanup(() => controller.abort());

    void Promise.all([loadModule('/script.js'), loadModule('/scripts/group-chats.js')]).then(([core, groups]) => {
      const context = window.SillyTavern?.getContext?.();
      const events = context?.eventSource, loadedEvent = context?.eventTypes?.CHAT_LOADED;
      if (signal.aborted || !loadedEvent || typeof events?.makeFirst !== 'function' || typeof events.removeListener !== 'function'
        || !Array.isArray(core.characters) || !('this_chid' in core) || !('selected_group' in groups)
        || typeof core.isChatSaving !== 'boolean' || typeof core.is_send_press !== 'boolean' || typeof groups.is_group_generating !== 'boolean'
        || ['selectCharacterById', 'unshallowCharacter', 'setActiveCharacter', 'saveSettingsDebounced', 'getRequestHeaders',
          'updateRemoteChatName'].some(key => typeof core[key] !== 'function')) return;

      const busy = () => core.isChatSaving || core.is_send_press || groups.is_group_generating;
      const selected = (id: number) => !groups.selected_group && String(core.this_chid) === String(id);

      async function open(row: HTMLElement, id: number, avatar: string, file: string) {
        const origin = core.this_chid, group = groups.selected_group;
        // Hydration can replace the entire character object, including its remembered chat.
        if (core.characters[id].shallow) await core.unshallowCharacter(id);
        const character: Character | undefined = core.characters[id];
        if (signal.aborted || !row.isConnected || row.dataset.file !== file || row.dataset.avatar !== avatar
          || core.this_chid !== origin || groups.selected_group !== group) return;
        if (!character || character.avatar !== avatar || character.shallow || busy()) throw new Error('角色尚未就绪，请稍后重试');

        const previous = character.chat;
        const remember = previous !== file || unconfirmed.get(character) === file;
        let loaded = false;
        const confirm = ({ detail }: ChatLoaded = {}) => {
          if (String(detail?.id) === String(id) && detail?.character?.avatar === avatar && detail.character.chat === file) loaded = true;
        };
        // getChat catches read errors internally. Only its success path emits CHAT_LOADED.
        events.makeFirst(loadedEvent, confirm);
        try {
          character.chat = file;
          await core.selectCharacterById(id);
          if (!loaded) throw new Error('酒馆未确认载入目标聊天，请重新打开');
          if (!selected(id) || core.characters[id]?.avatar !== avatar || core.characters[id]?.chat !== file) return;
          core.setActiveCharacter(avatar);
          core.saveSettingsDebounced();
          if (remember) {
            // Same narrow write as updateRemoteChatName, with an observable HTTP failure.
            unconfirmed.set(character, file);
            const response = await fetch('/api/characters/merge-attributes', {
              method: 'POST', headers: core.getRequestHeaders(), body: JSON.stringify({ avatar, chat: file }),
            });
            if (!response.ok) throw new Error('聊天已打开，但未保存为上次聊天');
            unconfirmed.delete(character);
          }
        } finally {
          events.removeListener(loadedEvent, confirm);
          // Never point the active transcript at a different file after a failed native load.
          if (!loaded && character.chat === file) {
            if (!selected(id)) character.chat = previous;
            else if (remember) unconfirmed.set(character, file);
          }
        }
      }

      document.getElementById('chat')?.addEventListener('click', event => {
        if (event.defaultPrevented || !(event.target instanceof Element)) return;
        const row = event.target.closest<HTMLElement>(recentRow);
        const avatar = row?.dataset.avatar, file = row?.dataset.file;
        if (!row || row.classList.contains('group') || row.dataset.group || !file || !avatar) return;
        const control = event.target.closest('button, a, input, [role="button"], .pinChat, .renameChat, .deleteChat');
        if (control && control !== row && row.contains(control)) return;
        const id = core.characters.findIndex((c: Character) => c?.avatar === avatar);
        const character: Character | undefined = core.characters[id];
        if (!opening && (!character || selected(id)
          || (!character.shallow && character.chat === file && unconfirmed.get(character) !== file))) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (opening) return;
        if (busy()) {
          (window as any).toastr?.info?.('请等当前生成或保存结束后再打开聊天');
          return;
        }
        opening = true;
        void open(row, id, avatar, file).catch(error => {
          console.warn('[Cの炼金工坊] 最近聊天', error);
          (window as any).toastr?.error?.(String(error.message || error), '最近聊天', { escapeHtml: true });
        }).finally(() => { opening = false; });
      }, { capture: true, signal });
    }).catch(error => console.warn('[Cの炼金工坊] 无法加载原生最近聊天接口', error));
  }, { immediate: true, flush: 'sync' });
}
