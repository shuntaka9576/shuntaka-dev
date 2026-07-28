<script lang="ts">
  // 旧 lab の StepRow / EnginePane 相当。
  // MySQL / PostgreSQL / DSQL をタブで切り替えながら 1 ステップずつ演習を進める UI
  type Result = 'ok' | 'error' | 'block' | 'idle';
  type Pane = {
    command?: string;
    output?: string;
    note?: string;
    result?: Result;
  };

  let {
    num,
    title,
    description,
    defaultEngine,
    panes,
  }: {
    num?: string | number;
    title: string;
    description?: string;
    defaultEngine?: string;
    panes: Record<string, Pane>;
  } = $props();

  const LABELS: Record<string, string> = {
    mysql: 'MySQL 8.0',
    postgres: 'PostgreSQL 16',
    dsql: 'Aurora DSQL',
  };

  const RESULT_BADGE: Record<Result, { label: string; class: string }> = {
    ok: { label: '成功', class: 'ok' },
    error: { label: 'エラー', class: 'error' },
    block: { label: 'ブロック（待機）', class: 'block' },
    idle: { label: '—', class: 'idle' },
  };

  const engines = $derived(Object.keys(panes));
  let active = $state('');
  const current = $derived(active || defaultEngine || Object.keys(panes)[0] || '');
</script>

<section class="engine-steps">
  <header>
    {#if num !== undefined}
      <span class="num">{typeof num === 'number' ? `Step ${num}` : num}</span>
    {/if}
    <h3>{title}</h3>
  </header>
  {#if description}
    <p class="desc">{description}</p>
  {/if}

  <div class="tabs" role="tablist">
    {#each engines as engine (engine)}
      <button
        type="button"
        role="tab"
        aria-selected={engine === current}
        class="tab"
        class:active={engine === current}
        onclick={() => (active = engine)}
      >
        {LABELS[engine] ?? engine}
      </button>
    {/each}
  </div>

  {#each engines as engine (engine)}
    {@const pane = panes[engine]}
    {@const badge = RESULT_BADGE[pane.result ?? 'idle']}
    <div class="pane" hidden={engine !== current}>
      {#if pane.command}
        <pre class="command"><code>{pane.command}</code></pre>
      {/if}
      {#if pane.output}
        <div class="output-wrap">
          <span class="badge {badge.class}">{badge.label}</span>
          <pre class="output"><code>{pane.output}</code></pre>
        </div>
      {/if}
      {#if pane.note}
        <p class="note">{pane.note}</p>
      {/if}
    </div>
  {/each}
</section>

<style>
  .engine-steps {
    margin: 2rem 0;
    padding-top: 1.1rem;
    border-top: 1px dashed var(--color-border, #c4c4c4);
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.4rem;
  }

  .num {
    background: #f4f6f9;
    border: 1px solid #dde3ea;
    color: #6b7280;
    font-size: 0.78rem;
    padding: 0.18rem 0.6rem;
    border-radius: 999px;
    font-weight: 600;
    white-space: nowrap;
  }

  h3 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
    color: #33383e;
  }

  .desc {
    color: #6b7280;
    font-size: 0.9rem;
    line-height: 1.7;
    margin: 0 0 0.75rem;
  }

  .tabs {
    display: flex;
    gap: 0.25rem;
    margin: 0.75rem 0 0;
    border-bottom: 1px solid #dde3ea;
  }

  .tab {
    cursor: pointer;
    padding: 0.4rem 0.85rem;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 0.4rem 0.4rem 0 0;
    background: transparent;
    color: #8b9299;
    font-size: 0.83rem;
    font-weight: 500;
    font-family: inherit;
  }

  .tab.active {
    background: #fff;
    border-color: #dde3ea;
    color: #33383e;
    position: relative;
    top: 1px;
  }

  .pane {
    border: 1px solid #dde3ea;
    border-top: 0;
    border-radius: 0 0 0.5rem 0.5rem;
    padding: 0.9rem;
    background: #fff;
  }

  pre {
    margin: 0;
    padding: 0.75rem 0.9rem;
    border-radius: 0.4rem;
    overflow-x: auto;
    font-size: 0.82rem;
    line-height: 1.6;
  }

  .command {
    background: #2b303b;
    color: #dfe3ea;
  }

  .output-wrap {
    margin-top: 0.6rem;
  }

  .badge {
    display: inline-block;
    font-size: 0.72rem;
    font-weight: 600;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    margin-bottom: 0.35rem;
  }

  .badge.ok {
    background: #e7f7ed;
    color: #16803c;
  }

  .badge.error {
    background: #fdecec;
    color: #c53030;
  }

  .badge.block {
    background: #fff2b8;
    color: #8a6d00;
  }

  .badge.idle {
    background: #f4f6f9;
    color: #8b9299;
  }

  .output {
    background: #f6f8fa;
    color: #33383e;
    border: 1px solid #eef1f5;
  }

  .note {
    margin: 0.6rem 0 0;
    font-size: 0.82rem;
    color: #8b9299;
    line-height: 1.6;
  }
</style>
