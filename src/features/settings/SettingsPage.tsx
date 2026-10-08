import { useEffect, useRef, useState } from 'react';
import { loadLLMSettings, saveLLMSettings, testLLMSettings, validateDraft, type LLMDraft, type LLMSettings } from './llmSettings';
import type { Theme } from './theme';
import './settings.css';

type Props = {
  theme: Theme; onTheme: (theme: Theme) => void;
  sidebarCollapsed: boolean; onSidebar: (collapsed: boolean) => void;
  panelPercent: number; onPanel: (percent: number) => void;
  generating: boolean; onSaved: (settings: LLMSettings) => void; onClose: () => void;
};
export function SettingsPage(props: Props) {
  const [saved, setSaved] = useState<LLMSettings>();
  const [draft, setDraft] = useState<LLMDraft>();
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | null>('load');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  const populate = (settings: LLMSettings) => {
    setSaved(settings);
    setDraft({ mode: settings.mode, baseUrl: settings.baseUrl, model: settings.model, timeoutMs: settings.timeoutMs });
    setApiKey(''); setClearKey(false); setShowKey(false); setDirty(false);
  };
  const load = async () => {
    setBusy('load'); setError('');
    try { const settings = await loadLLMSettings(); if (alive.current) populate(settings); }
    catch (cause) { if (alive.current) setError((cause as Error).message); }
    finally { if (alive.current) setBusy(null); }
  };
  useEffect(() => {
    alive.current = true;
    heading.current?.focus();
    void load();
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const close = () => {
    if (!busy && (!dirty || window.confirm('模型配置尚未保存，确定放弃修改并返回？'))) props.onClose();
  };
  const changed = () => { setDirty(true); setError(''); setStatus(''); };
  const update = (patch: Partial<LLMDraft>) => { setDraft(current => current && { ...current, ...patch }); changed(); };
  const submit = async (action: 'save' | 'test') => {
    if (!draft || !saved || busy || (action === 'save' && props.generating)) return;
    const value: LLMDraft = {
      ...draft, baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''), model: draft.model.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearKey ? { clearApiKey: true } : {}),
    };
    const invalid = validateDraft(value, saved.hasApiKey);
    if (invalid) { setError(invalid); setStatus(''); return; }
    setBusy(action); setError(''); setStatus('');
    try {
      if (action === 'save') {
        const settings = await saveLLMSettings(value);
        if (!alive.current) return;
        populate(settings); props.onSaved(settings);
        setStatus('模型配置已保存，后续问答立即使用新配置。');
      } else {
        await testLLMSettings(value);
        if (alive.current) setStatus(value.mode === 'mock' ? 'Mock 演示模式可用；未访问外部模型。' : '连接测试成功；仅验证最小文本请求，未保存此草稿。');
      }
    } catch (cause) { if (alive.current) setError((cause as Error).message); }
    finally { if (alive.current) setBusy(null); }
  };
  return <main className="settings-page" aria-labelledby="settings-title">
    <div className="settings-content">
      <div className="settings-heading"><div><h1 id="settings-title" ref={heading} tabIndex={-1}>软件设置</h1><p>外观与布局保存在当前浏览器；模型配置保存在本机服务端。</p></div>
        <button onClick={close} disabled={!!busy}>返回工作台</button></div>
      <section className="settings-section" aria-labelledby="appearance-title">
        <h2 id="appearance-title">外观与布局</h2><p className="settings-note">修改立即生效，刷新后保留；不会改变图节点坐标或知识内容。</p>
        <div className="settings-grid">
          <label>主题<select aria-label="主题" value={props.theme} onChange={event => props.onTheme(event.target.value as Theme)}><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <label className="settings-check"><input type="checkbox" checked={!props.sidebarCollapsed} onChange={event => props.onSidebar(!event.target.checked)} />展开工作空间侧栏</label>
          <label>问答面板宽度：{Math.round(props.panelPercent)}%<input type="range" min={25} max={75} step={1} value={props.panelPercent} onChange={event => props.onPanel(Number(event.target.value))} /></label>
          <div className="settings-layout-reset"><button onClick={() => { props.onSidebar(true); props.onPanel(50); }}>恢复默认布局</button><small>侧栏收起，问答面板占 50%</small></div>
        </div>
      </section>
      <section className="settings-section" aria-labelledby="model-title">
        <h2 id="model-title">大模型 API</h2>
        <p className="settings-note">支持文本 Chat Completions 的 OpenAI 兼容接口。真实模型会收到当前探索路径的问答；请确认供应商隐私政策。不要将本机服务暴露到公网。</p>
        {busy === 'load' && <p role="status">正在读取配置…</p>}
        {!draft && busy !== 'load' && <button onClick={() => void load()}>重试读取配置</button>}
        {draft && saved && <form onSubmit={event => { event.preventDefault(); void submit('save'); }}>
          <fieldset disabled={!!busy} className="settings-fields">
            <label>模型模式<select aria-label="模型模式" value={draft.mode} onChange={event => update({ mode: event.target.value as LLMDraft['mode'] })}><option value="mock">Mock · 演示模式</option><option value="openai-compatible">OpenAI-compatible · 真实模型</option></select></label>
            <label>Base URL<input aria-label="Base URL" type="url" required value={draft.baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" autoComplete="off" spellCheck={false} /><small>通常包含 /v1，不要包含 /chat/completions；远程服务建议使用 HTTPS。</small></label>
            <label>模型名称<input aria-label="模型名称" required maxLength={200} value={draft.model} onChange={event => update({ model: event.target.value })} placeholder="gpt-4o-mini" autoComplete="off" spellCheck={false} /></label>
            <label>API Key<span className="settings-key-row"><input aria-label="API Key" type={showKey ? 'text' : 'password'} value={apiKey} disabled={clearKey} maxLength={8192} onChange={event => { setApiKey(event.target.value); changed(); }} autoComplete="new-password" spellCheck={false} placeholder={saved.hasApiKey ? '已保存密钥；留空保留原密钥' : '尚未设置密钥'} /><button type="button" disabled={clearKey} aria-pressed={showKey} onClick={() => setShowKey(current => !current)}>{showKey ? '隐藏密钥' : '显示密钥'}</button></span><small>{saved.hasApiKey ? '服务端已有密钥（不回传浏览器）。填写新密钥会替换原密钥。' : '服务端未保存密钥。真实模式需要填写密钥。'}</small></label>
            {saved.hasApiKey && <label className="settings-check"><input type="checkbox" checked={clearKey} onChange={event => { setClearKey(event.target.checked); setApiKey(''); setShowKey(false); changed(); }} />保存时删除已有密钥（需切换 Mock）</label>}
            <label>请求超时（秒）<input aria-label="请求超时（秒）" type="number" min={1} max={600} step={0.001} required value={Number.isFinite(draft.timeoutMs) ? draft.timeoutMs / 1000 : ''} onChange={event => update({ timeoutMs: event.target.value === '' ? NaN : Number(event.target.value) * 1000 })} /></label>
          </fieldset>
          <p className="settings-note">密钥仅随配置请求提交到本机服务，明文保存在 .meshnote/llm-settings.json（不进入 Git），不写入浏览器存储。保存后重启仍有效；Mock 模式不调用外部 API，已有密钥可保留。</p>
          {props.generating && <p className="settings-note" role="status">当前正在生成回答，请结束生成后再保存模型配置。</p>}
          <div className="settings-actions"><button type="button" disabled={!!busy} onClick={() => void submit('test')}>{busy === 'test' ? '正在测试…' : '测试连接'}</button><button className="primary" disabled={!!busy || props.generating}>{busy === 'save' ? '正在保存…' : '保存模型配置'}</button><span className="settings-note">{dirty ? '模型配置有未保存修改' : '模型配置已同步'}</span></div>
          <p className="settings-note">测试使用当前草稿、不保存配置；会将新输入或已保存的密钥发送到当前 Base URL，请只填写可信地址。真实模型测试会发出一个最小文本请求，可能产生少量费用。测试成功不保证所有流式协议兼容。</p>
        </form>}
        {error && <p className="inline-error" role="alert">{error}</p>}
        {status && <p className="settings-success" role="status">{status}</p>}
      </section>
    </div>
  </main>;
}
