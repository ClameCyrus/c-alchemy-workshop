import { watch } from 'vue';

type Character = { avatar: string; chat: string; shallow?: boolean };
type ChatLoaded = { detail?: { id?: number | string; character?: Character } };
export type RecentCharacterChat = { avatar: string; fileName: string };
type OpenChat = (target: RecentCharacterChat, row?: HTMLElement) => Promise<void>;
const recentRow = '#chat > .welcomePanel .recentChatList > .recentChat[data-avatar][data-file]';
const loadModule = (path: string) => import(/* webpackIgnore: true */ new URL(path, location.href).href);

export function installNativeRecentChat(enabled: () => boolean) {
  let pending: { target: RecentCharacterChat; done: Promise<void> } | undefined;
  let ready: Promise<OpenChat | undefined> | undefined;
  const unconfirmed = new WeakMap<Character, string>();
  function pendingOpen(target: RecentCharacterChat) {
    if (!pending) return;
    if (pending.target.avatar === target?.avatar && pending.target.fileName === target?.fileName) return pending.done;
    throw new Error('正在打开另一份聊天，请稍后再试');
  }
  const stop = watch(enabled, (on, _, cleanup) => {
    if (!on) return;
    const controller = new AbortController();
    const { signal } = controller;
    cleanup(() => { ready = undefined; controller.abort(); });

    ready = Promise.all([loadModule('/script.js'), loadModule('/scripts/group-chats.js')]).then(([core, groups]) => {
      const context = window.SillyTavern?.getContext?.();
      const events = context?.eventSource, loadedEvent = context?.eventTypes?.CHAT_LOADED;
      if (signal.aborted || !loadedEvent || typeof events?.makeFirst !== 'function' || typeof events.removeListener !== 'function'
        || !Array.isArray(core.characters) || !('this_chid' in core) || !('selected_group' in groups)
        || typeof core.isChatSaving !== 'boolean' || typeof core.is_send_press !== 'boolean' || typeof groups.is_group_generating !== 'boolean'
        || ['selectCharacterById', 'openCharacterChat', 'getCurrentChatId', 'unshallowCharacter', 'setActiveCharacter', 'saveSettingsDebounced', 'getRequestHeaders',
          'updateRemoteChatName'].some(key => typeof core[key] !== 'function')) return;

      const busy = () => core.isChatSaving || core.is_send_press || groups.is_group_generating;
      const selected = (id: number) => !groups.selected_group && String(core.this_chid) === String(id);

      async function open({ avatar, fileName: file }: RecentCharacterChat, row?: HTMLElement) {
        const id = core.characters.findIndex((c: Character) => c?.avatar === avatar);
        if (id < 0) throw new Error('角色不存在，请刷新聊天目录');
        const origin = core.this_chid, group = groups.selected_group, chat = core.getCurrentChatId();
        const checkOrigin = () => {
          if (signal.aborted || core.this_chid !== origin || groups.selected_group !== group || core.getCurrentChatId() !== chat
            || core.characters[id]?.avatar !== avatar || (row && (!row.isConnected || row.dataset.file !== file || row.dataset.avatar !== avatar))) {
            throw new Error('聊天或目录已切换，本次打开已取消');
          }
          if (busy()) throw new Error('请等当前生成或保存结束后再打开聊天');
        };
        checkOrigin();
        if (selected(id) && chat === file && unconfirmed.get(core.characters[id]) !== file) return;
        if (!row) {
          // A stale script request must not let getChat create a new chat for a missing file.
          const response = await fetch('/api/characters/chats', {
            method: 'POST', headers: core.getRequestHeaders(), signal,
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
          });
          if (!response.ok) throw new Error('无法核对角色的聊天目录');
          const files = await response.json();
          if (!Array.isArray(files) || !files.some(item => item?.file_name === file + '.jsonl')) {
            throw new Error('目标聊天不在该角色的目录中，请刷新目录');
          }
          checkOrigin();
        }
        // Hydration can replace the entire character object, including its remembered chat.
        if (core.characters[id].shallow) {
          await core.unshallowCharacter(id);
          checkOrigin();
        }
        const character: Character = core.characters[id];
        if (character.shallow) throw new Error('角色尚未就绪，请稍后重试');

        const previous = character.chat;
        const sameCharacter = selected(id);
        const remember = previous !== file || unconfirmed.get(character) === file;
        let loaded = false;
        const confirm = ({ detail }: ChatLoaded = {}) => {
          if (String(detail?.id) === String(id) && detail?.character?.avatar === avatar && detail.character.chat === file) loaded = true;
        };
        // getChat catches read errors internally. Only its success path emits CHAT_LOADED.
        events.makeFirst(loadedEvent, confirm);
        try {
          if (sameCharacter) {
            // Let Tavern clear the outgoing transcript before changing its file name.
            await core.openCharacterChat(file);
          } else {
            character.chat = file;
            await core.selectCharacterById(id);
          }
          if (!loaded) throw new Error('酒馆未确认载入目标聊天，请重新打开');
          if (!selected(id) || core.characters[id]?.avatar !== avatar || core.characters[id]?.chat !== file) {
            throw new Error('当前聊天已经切换');
          }
          core.setActiveCharacter(avatar);
          core.saveSettingsDebounced();
          if (sameCharacter) unconfirmed.delete(character); // openCharacterChat already persists the selection.
          else if (remember) {
            // Same narrow write as updateRemoteChatName, with an observable HTTP failure.
            unconfirmed.set(character, file);
            const response = await fetch('/api/characters/merge-attributes', {
              method: 'POST', headers: core.getRequestHeaders(), body: JSON.stringify({ avatar, chat: file }),
            });
            if (!response.ok) throw new Error('聊天已打开，但未保存为上次聊天');
            unconfirmed.delete(character);
          }
        } catch (error) {
          // Never point the active transcript at a different file after a failed native load.
          // A native character save can also replace the object in the character list.
          const current: Character | undefined = core.characters[id];
          if (selected(id) && current?.avatar === avatar && current.chat === file) unconfirmed.set(current, file);
          else if (!loaded && character.chat === file && !selected(id)) character.chat = previous;
          throw error;
        } finally {
          events.removeListener(loadedEvent, confirm);
        }
      }

      const start: OpenChat = async (target, row) => {
        const existing = pendingOpen(target);
        if (existing) return existing;
        const done = open(target, row).finally(() => { pending = undefined; });
        pending = { target, done };
        return done;
      };

      document.getElementById('chat')?.addEventListener('click', event => {
        if (event.defaultPrevented || !(event.target instanceof Element)) return;
        const row = event.target.closest<HTMLElement>(recentRow);
        const avatar = row?.dataset.avatar, file = row?.dataset.file;
        if (!row || row.classList.contains('group') || row.dataset.group || !file || !avatar) return;
        const control = event.target.closest('button, a, input, [role="button"], .pinChat, .renameChat, .deleteChat');
        if (control && control !== row && row.contains(control)) return;
        const id = core.characters.findIndex((c: Character) => c?.avatar === avatar);
        const character: Character | undefined = core.characters[id];
        if (!pending && (!character || selected(id)
          || (!character.shallow && character.chat === file && unconfirmed.get(character) !== file))) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (pending) return;
        if (busy()) {
          (window as any).toastr?.info?.('请等当前生成或保存结束后再打开聊天');
          return;
        }
        void start({ avatar, fileName: file }, row).catch(error => {
          if (signal.aborted || (!row.isConnected && core.this_chid == null)) return;
          console.warn('[Cの炼金工坊] 最近聊天', error);
          (window as any).toastr?.error?.(String(error?.message || error), '最近聊天', { escapeHtml: true });
        });
      }, { capture: true, signal });
      return start;
    }).catch(error => { console.warn('[Cの炼金工坊] 无法加载原生最近聊天接口', error); return undefined; });
  }, { immediate: true, flush: 'sync' });

  async function openRecentCharacterChat(target: RecentCharacterChat): Promise<boolean> {
    const existing = pendingOpen(target);
    if (existing) { await existing; return true; }
    const session = ready;
    if (!session) return false;
    if (typeof target?.avatar !== 'string' || !target.avatar.trim() || typeof target.fileName !== 'string' || !target.fileName.trim()) {
      throw new Error('请提供角色头像文件标识和聊天文件名');
    }
    const { avatar, fileName } = target;
    const start = await session;
    if (session !== ready) throw new Error('最近聊天优化状态已变更，请重试');
    if (!start) return false;
    await start({ avatar, fileName });
    return true;
  }
  return { stop, openRecentCharacterChat };
}
