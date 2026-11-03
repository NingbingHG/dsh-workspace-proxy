/**
 * dsh-workspace-proxy — the Web panel half.
 *
 * A left-sidebar entry ("proxy-settings") plus the main panel it selects. The panel edits
 * the Host's settings document over the plugin's own JSON route, so adding a proxy, binding
 * it to workspaces, or changing the default takes effect on the next outbound request.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-proxy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = new URL('proxy-settings/api', document.baseURI).toString()
    const TEST = new URL('proxy-settings/test', document.baseURI).toString()

    /** The Client context, captured when the plugin applies; used for locale lookups. */
    let pluginCtx = null

    /* ------------------------------------------------------------------ */
    /* Text                                                               */
    /* ------------------------------------------------------------------ */

    const EN = {
      'panel.title': 'Proxy',
      'panel.heading': 'Proxy settings',
      'panel.subtitle':
        'Route DeepSeek Harness outbound requests through a proxy. Bind a proxy to workspaces to use a different one per project.',
      'label.enableRouting': 'Enable proxy routing',
      'label.fallback': 'Connect directly when a proxy is unreachable',
      'label.on': 'On',
      'label.off': 'Off',
      'label.workspaces': 'Applies to workspaces',
      'label.defaultProxy': 'Default proxy',
      'label.file': 'Settings file',
      'action.add': 'Add proxy',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.enable': 'Enable',
      'action.disable': 'Disable',
      'action.setDefault': 'Set default',
      'action.unsetDefault': 'Clear default',
      'action.test': 'Test',
      'action.retry': 'Retry',
      'tag.default': 'Default',
      'tag.disabled': 'Disabled',
      'tag.enabled': 'Enabled',
      'tag.unreachable': 'No response',
      'hint.default': 'Used for every request that no workspace binding matches.',
      'hint.noWorkspaces': 'Without a workspace binding this proxy is only used as the default.',
      'hint.workspaces': 'A Session started in one of these workspaces routes through this proxy.',
      'empty.proxies': 'No proxy yet. Add one to send Harness traffic through it.',
      'empty.proxiesAction': 'Add your first proxy',
      'empty.workspaces': 'No workspace yet. Create one from the sidebar first.',
      'editor.new': 'New proxy',
      'editor.edit': 'Edit proxy',
      'field.name': 'Name',
      'field.namePlaceholder': 'Office proxy',
      'field.url': 'Proxy address',
      'field.urlHint': 'http:// or https:// only, for example http://127.0.0.1:7890',
      'field.username': 'Username (optional)',
      'field.password': 'Password (optional)',
      'field.passwordStored': 'A password is stored; leave blank to keep it',
      'field.clearPassword': 'Clear the stored password',
      'field.noProxy': 'Bypass list (optional)',
      'field.noProxyHint': 'Comma separated hosts, for example .internal, git.company.com',
      'field.makeDefault': 'Use as the default proxy',
      'warn.engine': 'Proxy routing is inactive',
      'warn.error': 'Save failed',
      'error.load': 'Could not load settings',
      'notice.saved': 'Saved',
      'confirm.delete': 'Delete this proxy?',
      'status.saving': 'Saving…',
      'test.running': 'Testing…',
      'test.direct': 'Direct connection',
      'test.viaProxy': 'Through {name}',
      'test.ok': 'HTTP {status} in {ms} ms',
      'test.failed': 'Failed: {error}',
      'workspace.unknown': 'Deleted workspace',
      'route.default': 'default',
      'route.workspace': 'workspace',
    }

    const ZH = {
      'panel.title': '代理',
      'panel.heading': '代理设置',
      'panel.subtitle': '让 DeepSeek Harness 的出站请求走代理；把代理关联到工作区，即可按项目使用不同代理。',
      'label.enableRouting': '启用代理路由',
      'label.fallback': '代理不可达时自动直连',
      'label.on': '开',
      'label.off': '关',
      'label.workspaces': '生效工作区',
      'label.defaultProxy': '默认代理',
      'label.file': '设置文件',
      'action.add': '添加代理',
      'action.edit': '编辑',
      'action.delete': '删除',
      'action.save': '保存',
      'action.cancel': '取消',
      'action.enable': '启用',
      'action.disable': '停用',
      'action.setDefault': '设为默认',
      'action.unsetDefault': '取消默认',
      'action.test': '测试',
      'action.retry': '重试',
      'tag.default': '默认',
      'tag.disabled': '已停用',
      'tag.enabled': '已启用',
      'tag.unreachable': '无响应',
      'hint.default': '未匹配到任何工作区关联时使用此代理。',
      'hint.noWorkspaces': '没有关联工作区时，此代理仅在作为默认代理时生效。',
      'hint.workspaces': '在这些工作区中发起的会话会经由此代理出站。',
      'empty.proxies': '还没有代理。添加一个即可让 Harness 的流量经过它。',
      'empty.proxiesAction': '添加第一个代理',
      'empty.workspaces': '还没有工作区，请先在左栏创建工作区。',
      'editor.new': '新建代理',
      'editor.edit': '编辑代理',
      'field.name': '名称',
      'field.namePlaceholder': '公司代理',
      'field.url': '代理地址',
      'field.urlHint': '仅支持 http:// 或 https://，例如 http://127.0.0.1:7890',
      'field.username': '用户名（可选）',
      'field.password': '密码（可选）',
      'field.passwordStored': '已保存密码，留空则不修改',
      'field.clearPassword': '清除已保存的密码',
      'field.noProxy': '直连列表（可选）',
      'field.noProxyHint': '以逗号分隔主机名，例如 .internal, git.company.com',
      'field.makeDefault': '作为默认代理',
      'warn.engine': '代理路由未生效',
      'warn.error': '保存失败',
      'error.load': '读取设置失败',
      'notice.saved': '已保存',
      'confirm.delete': '确定删除这个代理吗？',
      'status.saving': '保存中…',
      'test.running': '测试中…',
      'test.direct': '直连',
      'test.viaProxy': '经由 {name}',
      'test.ok': 'HTTP {status}，{ms} 毫秒',
      'test.failed': '失败：{error}',
      'workspace.unknown': '已删除的工作区',
      'route.default': '默认',
      'route.workspace': '工作区',
    }

    /** Prefer the Harness locale, then the browser language. */
    function detectLanguage(ctx) {
      try {
        const snapshot = ctx.locale?.getLocale?.()
        const id = typeof snapshot === 'string' ? snapshot : snapshot?.id ?? snapshot?.locale ?? snapshot?.language
        if (typeof id === 'string' && id !== '') return /^zh/i.test(id) ? 'zh' : 'en'
      } catch {
        // Locale is optional.
      }
      const browser = typeof navigator !== 'undefined' ? navigator.language ?? '' : ''
      return /^zh/i.test(browser) ? 'zh' : 'en'
    }

    /** Translate through the Harness dictionary when it answers, else through the local one. */
    function makeT(ctx) {
      const language = detectLanguage(ctx)
      const dict = language === 'zh' ? ZH : EN
      let bound
      try {
        const translate = ctx.locale?.bind?.('proxy-settings')
        if (typeof translate === 'function') bound = translate
      } catch {
        bound = undefined
      }
      return (key, params) => {
        let text
        if (bound) {
          try {
            const answer = bound(key, params)
            if (typeof answer === 'string' && answer !== key) text = answer
          } catch {
            text = undefined
          }
        }
        if (text === undefined) text = dict[key] ?? EN[key] ?? key
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value))
          }
        }
        return text
      }
    }

    /* ------------------------------------------------------------------ */
    /* Style                                                              */
    /* ------------------------------------------------------------------ */

    const STYLE = `
.ps-page{box-sizing:border-box;width:100%;max-width:100%;min-width:0;height:100%;overflow:auto;padding:24px 24px 72px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.ps-inner{width:100%;max-width:700px;min-width:0;display:flex;flex-direction:column;gap:20px}
.ps-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;min-width:0}
.ps-title{margin:0;font-size:21px;font-weight:600;letter-spacing:-.01em}
.ps-sub{margin:6px 0 0;color:var(--dsw-alias-label-secondary);max-width:56ch;overflow-wrap:anywhere}
.ps-banner{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-width:0;overflow-wrap:anywhere}
.ps-banner[data-tone=warn]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.ps-banner[data-tone=error]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.ps-banner[data-tone=ok]{color:var(--dsw-alias-label-secondary)}
.ps-toolbar{display:flex;align-items:center;justify-content:flex-start;gap:24px 28px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);min-width:0;flex-wrap:wrap}
.ps-toolbar-label{display:flex;align-items:center;gap:10px;font-weight:500;min-width:0}
.ps-list{display:flex;flex-direction:column;gap:12px;min-width:0}
.ps-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-width:0}
.ps-card[data-disabled=true]{opacity:.62}
.ps-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ps-card-title{display:flex;align-items:center;gap:8px;min-width:0}
.ps-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.ps-dot[data-on=true]{background:var(--dsw-alias-state-success-primary)}
.ps-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ps-tag[data-tone=brand]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.ps-tag[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ps-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.ps-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}
.ps-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.ps-btn:disabled{opacity:.5;cursor:default}
.ps-btn[data-tone=primary]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:600}
.ps-btn[data-tone=quiet]{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ps-btn[data-tone=danger]:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ps-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.ps-ws{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ps-ws-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.ps-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.ps-chip[data-unknown=true]{color:var(--dsw-alias-state-warn-primary)}
.ps-muted{color:var(--dsw-alias-label-secondary)}
.ps-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ps-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:36px 24px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.ps-editor{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.ps-editor-title{margin:0;font-size:14px;font-weight:600}
.ps-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.ps-field-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.ps-field-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.ps-input{box-sizing:border-box;width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.ps-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;border-color:transparent}
.ps-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ps-ws-list{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px}
.ps-ws-item{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;cursor:pointer}
.ps-ws-item:hover{background:var(--dsw-alias-bg-layer-2)}
.ps-ws-title{font-size:12px}
.ps-ws-path{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-check{display:flex;align-items:center;gap:8px;cursor:pointer}
.ps-editor-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.ps-switch{position:relative;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;flex:none}
.ps-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.ps-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}
.ps-switch[aria-checked=true]::after{transform:translateX(14px)}
.ps-foot{display:block;max-width:100%;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;word-break:break-all;line-height:1.7}
.ps-foot>span{display:block;max-width:100%}
.ps-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (max-width:720px){.ps-page{padding:20px 0 64px}.ps-row2{grid-template-columns:1fr}}
`

    /* ------------------------------------------------------------------ */
    /* Data                                                               */
    /* ------------------------------------------------------------------ */

    function messageOf(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    async function readJson(response) {
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`)
      }
    }

    function newProxyId() {
      return `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    }

    function displayUrl(proxy) {
      try {
        const url = new URL(proxy.url)
        if (proxy.username) {
          url.username = proxy.username
          url.password = ''
        }
        const text = url.toString().replace(/\/$/, '')
        return proxy.hasPassword ? `${text} ••••` : text
      } catch {
        return proxy.url
      }
    }

    /* ------------------------------------------------------------------ */
    /* Small controls                                                     */
    /* ------------------------------------------------------------------ */

    function Field({ label, hint, children }) {
      return h(
        'div',
        { className: 'ps-field' },
        h('span', { className: 'ps-field-label' }, label),
        children,
        hint ? h('span', { className: 'ps-field-hint' }, hint) : null,
      )
    }

    function Switch({ checked, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        className: 'ps-switch',
        onClick: () => onChange(!checked),
      })
    }

    function Editor({ draft, workspaces, t, onCancel, onSubmit }) {
      const [value, setValue] = useState(draft)
      const set = (patch) => setValue((current) => ({ ...current, ...patch }))
      const toggleWorkspace = (id) =>
        setValue((current) => ({
          ...current,
          workspaceIds: current.workspaceIds.includes(id)
            ? current.workspaceIds.filter((entry) => entry !== id)
            : [...current.workspaceIds, id],
        }))
      const submit = (event) => {
        event.preventDefault()
        onSubmit(value)
      }
      return h(
        'form',
        { className: 'ps-card ps-editor', onSubmit: submit },
        h('h3', { className: 'ps-editor-title' }, draft.id ? t('editor.edit') : t('editor.new')),
        h(
          Field,
          { label: t('field.name') },
          h('input', {
            className: 'ps-input',
            value: value.name,
            maxLength: 80,
            placeholder: t('field.namePlaceholder'),
            onChange: (event) => set({ name: event.target.value }),
          }),
        ),
        h(
          Field,
          { label: t('field.url'), hint: t('field.urlHint') },
          h('input', {
            className: 'ps-input',
            value: value.url,
            placeholder: 'http://127.0.0.1:7890',
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => set({ url: event.target.value }),
          }),
        ),
        h(
          'div',
          { className: 'ps-row2' },
          h(
            Field,
            { label: t('field.username') },
            h('input', {
              className: 'ps-input',
              value: value.username,
              autoComplete: 'off',
              spellCheck: false,
              onChange: (event) => set({ username: event.target.value }),
            }),
          ),
          h(
            Field,
            {
              label: t('field.password'),
              hint: draft.hasPassword && !value.clearPassword ? t('field.passwordStored') : undefined,
            },
            h('input', {
              className: 'ps-input',
              type: 'password',
              value: value.clearPassword ? '' : value.password,
              placeholder: draft.hasPassword && !value.clearPassword ? '••••••••' : '',
              disabled: Boolean(value.clearPassword),
              autoComplete: 'new-password',
              onChange: (event) => set({ password: event.target.value }),
            }),
            draft.hasPassword
              ? h(
                  'label',
                  { className: 'ps-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(value.clearPassword),
                    onChange: (event) => set({ clearPassword: event.target.checked, password: '' }),
                  }),
                  h('span', { className: 'ps-field-hint' }, t('field.clearPassword')),
                )
              : null,
          ),
        ),
        h(
          Field,
          { label: t('field.noProxy'), hint: t('field.noProxyHint') },
          h('input', {
            className: 'ps-input',
            value: value.noProxy,
            spellCheck: false,
            onChange: (event) => set({ noProxy: event.target.value }),
          }),
        ),
        h(
          'div',
          { className: 'ps-field' },
          h('span', { className: 'ps-field-label' }, t('label.workspaces')),
          h(
            'div',
            { className: 'ps-ws-list' },
            workspaces.length === 0
              ? h('p', { className: 'ps-hint' }, t('empty.workspaces'))
              : workspaces.map((workspace) =>
                  h(
                    'label',
                    { key: workspace.id, className: 'ps-ws-item' },
                    h('input', {
                      type: 'checkbox',
                      checked: value.workspaceIds.includes(workspace.id),
                      onChange: () => toggleWorkspace(workspace.id),
                    }),
                    h('span', { className: 'ps-ws-title' }, workspace.title || workspace.path),
                    h('span', { className: 'ps-ws-path' }, workspace.path),
                  ),
                ),
          ),
          h('span', { className: 'ps-field-hint' }, t('hint.workspaces')),
        ),
        h(
          'label',
          { className: 'ps-check' },
          h('input', {
            type: 'checkbox',
            checked: Boolean(value.makeDefault),
            onChange: (event) => set({ makeDefault: event.target.checked }),
          }),
          h('span', null, t('field.makeDefault')),
        ),
        h(
          'div',
          { className: 'ps-editor-actions' },
          h('button', { type: 'button', className: 'ps-btn', onClick: onCancel }, t('action.cancel')),
          h('button', { type: 'submit', className: 'ps-btn', 'data-tone': 'primary' }, t('action.save')),
        ),
      )
    }

    function ProxyCard({ proxy, isDefault, workspaces, t, busy, onEdit, onDelete, onToggle, onDefault, onTest, test, health }) {
      const titles = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
      const unreachable = health && health.ok === false
      return h(
        'article',
        { className: 'ps-card', 'data-disabled': proxy.enabled ? 'false' : 'true' },
        h(
          'div',
          { className: 'ps-card-head' },
          h(
            'div',
            { className: 'ps-card-title' },
            h('span', { className: 'ps-dot', 'data-on': proxy.enabled ? 'true' : 'false' }),
            h('span', { className: 'ps-name', title: proxy.name }, proxy.name),
            isDefault ? h('span', { className: 'ps-tag', 'data-tone': 'brand' }, t('tag.default')) : null,
            proxy.enabled ? null : h('span', { className: 'ps-tag' }, t('tag.disabled')),
            unreachable ? h('span', { className: 'ps-tag', 'data-tone': 'warn' }, t('tag.unreachable')) : null,
          ),
          h(
            'div',
            { className: 'ps-actions' },
            h(
              'button',
              { type: 'button', className: 'ps-btn', 'data-tone': 'quiet', disabled: busy, onClick: () => onDefault(proxy) },
              isDefault ? t('action.unsetDefault') : t('action.setDefault'),
            ),
            h(
              'button',
              { type: 'button', className: 'ps-btn', 'data-tone': 'quiet', disabled: busy, onClick: () => onToggle(proxy) },
              proxy.enabled ? t('action.disable') : t('action.enable'),
            ),
            h(
              'button',
              { type: 'button', className: 'ps-btn', 'data-tone': 'quiet', disabled: busy, onClick: () => onTest(proxy) },
              test?.running ? t('test.running') : t('action.test'),
            ),
            h(
              'button',
              { type: 'button', className: 'ps-btn', 'data-tone': 'quiet', onClick: () => onEdit(proxy) },
              t('action.edit'),
            ),
            h(
              'button',
              { type: 'button', className: 'ps-btn', 'data-tone': 'danger', disabled: busy, onClick: () => onDelete(proxy) },
              t('action.delete'),
            ),
          ),
        ),
        h('div', { className: 'ps-url' }, displayUrl(proxy)),
        h(
          'div',
          { className: 'ps-ws' },
          h('span', { className: 'ps-ws-label' }, t('label.workspaces')),
          proxy.workspaceIds.length === 0
            ? h('span', { className: 'ps-muted' }, t('hint.noWorkspaces'))
            : proxy.workspaceIds.map((id) => {
                const workspace = titles.get(id)
                return h(
                  'span',
                  { key: id, className: 'ps-chip', 'data-unknown': workspace ? 'false' : 'true' },
                  workspace ? workspace.title || workspace.path : t('workspace.unknown'),
                )
              }),
        ),
        isDefault ? h('p', { className: 'ps-hint' }, t('hint.default')) : null,
        test && (test.running || test.result)
          ? h(
              'p',
              { className: 'ps-hint', 'data-tone': test.result?.ok ? 'ok' : 'warn' },
              test.running
                ? t('test.running')
                : test.result.ok
                  ? `${test.result.via === 'proxy' ? t('test.viaProxy', { name: test.result.route?.proxyName ?? proxy.name }) : t('test.direct')} · ${t('test.ok', { status: test.result.status, ms: test.result.ms })}`
                  : t('test.failed', { error: test.result.error }),
            )
          : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Panel                                                              */
    /* ------------------------------------------------------------------ */

    function ProxyPanel() {
      const t = makeT(pluginCtx)
      const [state, setState] = useState({
        phase: 'loading',
        settings: null,
        workspaces: [],
        engine: null,
        health: {},
        file: '',
        error: null,
      })
      const [editing, setEditing] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [test, setTest] = useState({})

      const load = useCallback(async () => {
        try {
          const response = await fetch(API, { headers: { accept: 'application/json' } })
          const data = await readJson(response)
          if (!data.ok) throw new Error(data.error ?? 'load-failed')
          setState({
            phase: 'ready',
            settings: data.settings,
            workspaces: data.workspaces ?? [],
            engine: data.engine ?? null,
            health: data.health ?? {},
            file: data.file ?? '',
            error: null,
          })
        } catch (error) {
          setState((current) => ({ ...current, phase: 'error', error: messageOf(error) }))
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), 1600)
        return () => clearTimeout(timer)
      }, [notice])

      const save = useCallback(
        async (next) => {
          setState((current) => ({ ...current, settings: next, error: null }))
          setBusy(true)
          try {
            const response = await fetch(API, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(next),
            })
            const data = await readJson(response)
            if (!data.ok) throw new Error(data.error ?? 'save-failed')
            setState((current) => ({
              ...current,
              settings: data.settings,
              workspaces: data.workspaces ?? current.workspaces,
              engine: data.engine ?? current.engine,
              health: data.health ?? current.health,
              file: data.file ?? current.file,
              error: null,
            }))
            setNotice(t('notice.saved'))
          } catch (error) {
            setState((current) => ({ ...current, error: messageOf(error) }))
            load()
          } finally {
            setBusy(false)
          }
        },
        [load, t],
      )

      const settings = state.settings
      const startAdd = () =>
        setEditing({
          id: '',
          name: '',
          url: '',
          username: '',
          password: '',
          noProxy: '',
          workspaceIds: [],
          makeDefault: !settings?.defaultProxyId,
        })
      const startEdit = (proxy) =>
        setEditing({ ...proxy, makeDefault: settings?.defaultProxyId === proxy.id })

      const submitEditor = (value) => {
        if (!settings) return
        const id = value.id || newProxyId()
        const record = {
          id,
          name: value.name.trim() || t('editor.new'),
          url: value.url.trim(),
          username: value.username.trim(),
          password: value.clearPassword ? '' : value.password,
          // The Host never returns a stored password; empty means "keep the stored one".
          clearPassword: value.clearPassword === true,
          hasPassword: value.hasPassword === true && value.clearPassword !== true,
          noProxy: value.noProxy.trim(),
          enabled: value.id ? settings.proxies.find((proxy) => proxy.id === id)?.enabled ?? true : true,
          workspaceIds: value.workspaceIds,
        }
        const proxies = value.id
          ? settings.proxies.map((proxy) => (proxy.id === id ? record : proxy))
          : [...settings.proxies, record]
        let defaultProxyId = settings.defaultProxyId
        if (value.makeDefault) defaultProxyId = id
        else if (defaultProxyId === id) defaultProxyId = null
        setEditing(null)
        save({ ...settings, proxies, defaultProxyId })
      }

      const toggleEnabled = (proxy) =>
        save({
          ...settings,
          proxies: settings.proxies.map((entry) =>
            entry.id === proxy.id ? { ...entry, enabled: !entry.enabled } : entry,
          ),
        })

      const setDefault = (proxy) =>
        save({
          ...settings,
          defaultProxyId: settings.defaultProxyId === proxy.id ? null : proxy.id,
        })

      const remove = (proxy) => {
        if (!window.confirm(t('confirm.delete'))) return
        save({
          ...settings,
          proxies: settings.proxies.filter((entry) => entry.id !== proxy.id),
          defaultProxyId: settings.defaultProxyId === proxy.id ? null : settings.defaultProxyId,
        })
      }

      const runTest = async (proxy) => {
        setTest((current) => ({ ...current, [proxy.id]: { running: true, result: null } }))
        try {
          const url = new URL(TEST)
          url.searchParams.set('url', 'https://api.deepseek.com/')
          url.searchParams.set('proxyId', proxy.id)
          const response = await fetch(url.toString(), { headers: { accept: 'application/json' } })
          const data = await readJson(response)
          setTest((current) => ({ ...current, [proxy.id]: { running: false, result: data } }))
          load()
        } catch (error) {
          setTest((current) => ({
            ...current,
            [proxy.id]: { running: false, result: { ok: false, error: messageOf(error) } },
          }))
        }
      }

      const toggleRouting = () => {
        if (!settings) return
        save({ ...settings, enabled: !settings.enabled })
      }

      const toggleFallback = () => {
        if (!settings) return
        save({ ...settings, fallbackToDirect: settings.fallbackToDirect === false })
      }

      const engineWarning =
        state.engine && !state.engine.available
          ? `${t('warn.engine')}：${state.engine.reason ?? ''}`
          : null

      return h(
        'div',
        { className: 'ps-page' },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'ps-inner' },
          h(
            'div',
            { className: 'ps-head' },
            h(
              'div',
              null,
              h('h1', { className: 'ps-title' }, t('panel.heading')),
              h('p', { className: 'ps-sub' }, t('panel.subtitle')),
            ),
            h(
              'button',
              { type: 'button', className: 'ps-btn', 'data-tone': 'primary', onClick: startAdd, disabled: !settings },
              t('action.add'),
            ),
          ),
          engineWarning ? h('div', { className: 'ps-banner', 'data-tone': 'warn' }, engineWarning) : null,
          state.error
            ? h(
                'div',
                { className: 'ps-banner', 'data-tone': 'error' },
                `${t('warn.error')}：${state.error}`,
                h(
                  'button',
                  { type: 'button', className: 'ps-btn', 'data-tone': 'quiet', onClick: load },
                  t('action.retry'),
                ),
              )
            : null,
          notice ? h('div', { className: 'ps-banner', 'data-tone': 'ok' }, notice) : null,
          state.phase === 'loading'
            ? h('div', { className: 'ps-empty' }, '…')
            : state.phase === 'error'
              ? h(
                  'div',
                  { className: 'ps-empty' },
                  `${t('error.load')}：${state.error ?? ''}`,
                  h('button', { type: 'button', className: 'ps-btn', onClick: load }, t('action.retry')),
                )
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'ps-toolbar' },
                    h(
                      'div',
                      { className: 'ps-toolbar-label' },
                      h(Switch, {
                        checked: Boolean(settings.enabled),
                        label: t('label.enableRouting'),
                        onChange: toggleRouting,
                      }),
                      h('span', null, t('label.enableRouting')),
                      h('span', { className: 'ps-tag' }, settings.enabled ? t('label.on') : t('label.off')),
                    ),
                    h(
                      'div',
                      { className: 'ps-toolbar-label' },
                      h(Switch, {
                        checked: settings.fallbackToDirect !== false,
                        label: t('label.fallback'),
                        onChange: toggleFallback,
                      }),
                      h('span', { className: 'ps-muted' }, t('label.fallback')),
                    ),
                    busy ? h('span', { className: 'ps-muted' }, t('status.saving')) : null,
                  ),
                  editing
                    ? h(Editor, {
                        key: editing.id || 'new',
                        draft: editing,
                        workspaces: state.workspaces,
                        t,
                        onCancel: () => setEditing(null),
                        onSubmit: submitEditor,
                      })
                    : null,
                  settings.proxies.length === 0 && !editing
                    ? h(
                        'div',
                        { className: 'ps-empty' },
                        h('p', { className: 'ps-hint' }, t('empty.proxies')),
                        h(
                          'button',
                          { type: 'button', className: 'ps-btn', 'data-tone': 'primary', onClick: startAdd },
                          t('empty.proxiesAction'),
                        ),
                      )
                    : h(
                        'div',
                        { className: 'ps-list' },
                        settings.proxies.map((proxy) =>
                          h(ProxyCard, {
                            key: proxy.id,
                            proxy,
                            isDefault: settings.defaultProxyId === proxy.id,
                            workspaces: state.workspaces,
                            t,
                            busy,
                            test: test[proxy.id],
                            health: state.health?.[proxy.id],
                            onEdit: startEdit,
                            onDelete: remove,
                            onToggle: toggleEnabled,
                            onDefault: setDefault,
                            onTest: runTest,
                          }),
                        ),
                      ),
                  h(
                    'div',
                    { className: 'ps-foot' },
                    state.file
                      ? h(
                          'span',
                          null,
                          `${t('label.file')}：`,
                          h('span', { className: 'ps-code' }, state.file),
                        )
                      : null,
                    state.engine?.detail
                      ? h('span', null, `undici：${state.engine.detail}`)
                      : null,
                  ),
                ),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Registration                                                       */
    /* ------------------------------------------------------------------ */

    function PanelIcon({ size = 20 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', {
          d: 'M12 2.9 5 5.6v5.9c0 4.4 2.9 8.2 7 9.6 4.1-1.4 7-5.2 7-9.6V5.6L12 2.9Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M8.6 10.5h6.8M13.4 8.6l2 1.9-2 1.9M15.4 14.2H8.6M10.6 12.3l-2 1.9 2 1.9',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        const translate = () => makeT(pluginCtx)
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'proxy-settings',
              order: 20,
              label: () => translate()('panel.title'),
            },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'proxy-settings' }, ProxyPanel),
        )
      },
    }
  },
})
