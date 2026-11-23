import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GetApiSupermeshSessionidMailboxResponse } from '@/client/apis/index.type'
import { useAsyncState } from '@reause/core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { getApiSupermeshSessionIdMailbox, getApiSupermeshSessionRole } from '@/client/apis'
import { keys } from '@/client/config/query-keys'
import { useDshContext } from '@/client/hooks/use-dsh-context'
import { useTranslation } from '@/client/hooks/use-translation'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { supermeshMailbox: unknown }
}

/** 事件只是「可能变了」的信号：合并成一次请求，避免流式输出时把 mailbox 打成刷屏。 */
const REFRESH_DELAY_MS = 250

export function Panel({ sessionId }: Pick<PropsRuntime<'conversation.input.dock'>, 'sessionId'>) {
  const ctx = useDshContext()
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()
  const roles = useQuery({ queryKey: keys.sessionRole, queryFn: () => getApiSupermeshSessionRole() })
  // 只有插件自己管理的会话才有邮箱；其它会话连请求都不该发。
  const managed = roles.data?.sessions.some(session => session.sessionId === sessionId) === true
  const { state: mailbox, execute, error } = useAsyncState<GetApiSupermeshSessionidMailboxResponse['mailbox'], [AbortSignal]>(async (signal) => {
    try {
      const { mailbox: result } = await getApiSupermeshSessionIdMailbox({ id: sessionId }, { signal })
      return !signal.aborted && result?.sessionId === sessionId && Array.isArray(result.messages) ? result : null
    }
    catch (error) {
      if (signal.aborted)
        return null
      throw error
    }
  }, null, { immediate: false, resetOnExecute: false })

  // keep:effect Own the existing Session event subscription and cancel mailbox requests on disposal.
  useEffect(() => {
    if (!managed)
      return
    const reference = ctx.sessions.retain(sessionId, { source: 'supermeshMailbox' })
    const events = reference.binding.eventSource
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let queued = false
    const refresh = (): void => {
      if (running) {
        queued = true
        return
      }
      running = true
      void execute(0, controller.signal).catch(() => undefined).finally(() => {
        running = false
        if (queued && !controller.signal.aborted) {
          queued = false
          timer = setTimeout(refresh, REFRESH_DELAY_MS)
        }
      })
    }
    const schedule = (): void => {
      timer ??= setTimeout(refresh, REFRESH_DELAY_MS)
    }
    const unsubscribe = events.subscribe(() => {
      const { change } = events.getSnapshot()
      if (change.kind === 'settle-assistant' || change.entries.some(entry => entry.type === 'event'))
        schedule()
    })
    refresh()
    return () => {
      unsubscribe()
      if (timer)
        clearTimeout(timer)
      controller.abort()
      reference.release()
    }
  }, [ctx.sessions, sessionId, execute, managed])

  if (error || mailbox?.sessionId !== sessionId || mailbox.pendingCount === 0 || mailbox.messages.length === 0)
    return null

  return (
    <section className="box-border flex-none overflow-hidden mx-auto w-[calc(100%_-_var(--dsh-composer-side-clearance)_-_var(--dsh-composer-side-clearance)_-_var(--dsh-composer-dock-inset)_-_var(--dsh-composer-dock-inset)_-_var(--dsh-composer-dock-inset)_-_var(--dsh-composer-dock-inset))] max-w-[calc(var(--dsh-composer-card-max-width)_-_var(--dsh-composer-dock-inset)_-_var(--dsh-composer-dock-inset)_-_var(--dsh-composer-dock-inset)_-_var(--dsh-composer-dock-inset))] border-0 rounded-(--dsw-radius-lg) bg-(--dsw-specific-menu) [backdrop-filter:var(--dsw-menu-backdrop-filter)] shadow-(--dsw-elevation-panel) [--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)] [--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)] [--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)]" aria-label={t('mailboxTitle')}>
      <div className="flex flex-col gap-2 px-3 py-1.5">
        <button type="button" className="flex items-center gap-2.5 w-full p-0 border-0 bg-transparent text-left cursor-pointer" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(value => !value)}>
          <span className="grid shrink-0 place-items-center text-(--dsw-alias-label-tertiary)" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m3 6 9 7 9-7" />
            </svg>
          </span>
          <span className="shrink-0 text-[13px] leading-6 font-medium text-(--dsw-alias-label-primary)">{t('mailboxTitle')}</span>
          <span className="flex-[1_1_auto] min-w-0 overflow-hidden text-[13px] leading-5 font-normal text-(--dsw-alias-label-tertiary) truncate">{t('mailboxPending', { count: mailbox.pendingCount })}</span>
          <span className="grid shrink-0 place-items-center text-(--dsw-alias-label-tertiary)" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={collapsed ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
          </span>
        </button>
        {!collapsed && (
          <ul id={listId} className="flex flex-col gap-2 m-0 p-0 list-none max-h-45 overflow-y-auto">
            {mailbox.messages.map(message => (
              <li key={message.id} className="flex items-center gap-2.5 min-w-0 text-[13px] leading-5 text-(--dsw-alias-label-secondary)">
                <span className="grid shrink-0 place-items-center size-4" role="img" aria-label={t(message.status === 'stalled' ? 'mailboxStalled' : 'mailboxPendingStatus')}><span aria-hidden="true" className="relative inline-block flex-none size-2.5 text-(--dsw-alias-state-success-primary) after:content-[''] after:absolute after:inset-[20%] after:rounded-full after:[corner-shape:round] after:bg-current" /></span>
                <span className="min-w-0 overflow-hidden truncate" title={message.message}>{message.title ?? message.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
