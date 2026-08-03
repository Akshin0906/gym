import Markdown, {
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

const ALLOWED_ELEMENTS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const

function externalLink(href: string | undefined): boolean {
  return Boolean(href && /^(?:https?:)?\/\//i.test(href))
}

const COMPONENTS: Components = {
  a({ node: _node, href, children, ...props }) {
    const external = externalLink(href)
    return (
      <a
        {...props}
        href={href}
        className="text-[var(--color-accent)] underline decoration-current/50 underline-offset-2 hover:decoration-current"
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {children}
        {external && <span className="sr-only"> (opens in a new tab)</span>}
      </a>
    )
  },
  blockquote({ node: _node, ...props }) {
    return (
      <blockquote
        {...props}
        className="my-2 border-l-2 border-[var(--color-border)] pl-3 text-[var(--color-fg-dim)]"
      />
    )
  },
  code({ node: _node, className, ...props }) {
    return (
      <code
        {...props}
        className={`rounded bg-black/25 px-1 py-0.5 font-mono text-[0.82em] [overflow-wrap:anywhere] ${className ?? ''}`}
      />
    )
  },
  h1({ node: _node, ...props }) {
    return <h2 {...props} className="mt-3 mb-1 text-base font-bold first:mt-0" />
  },
  h2({ node: _node, ...props }) {
    return <h3 {...props} className="mt-3 mb-1 text-sm font-bold first:mt-0" />
  },
  h3({ node: _node, ...props }) {
    return <h4 {...props} className="mt-3 mb-1 text-sm font-semibold first:mt-0" />
  },
  h4({ node: _node, ...props }) {
    return <h5 {...props} className="mt-3 mb-1 text-sm font-semibold first:mt-0" />
  },
  h5({ node: _node, ...props }) {
    return <h6 {...props} className="mt-3 mb-1 text-sm font-semibold first:mt-0" />
  },
  h6({ node: _node, ...props }) {
    return <p {...props} className="mt-3 mb-1 text-sm font-semibold first:mt-0" />
  },
  hr({ node: _node, ...props }) {
    return <hr {...props} className="my-3 border-[var(--color-border)]" />
  },
  img({ node: _node, alt }) {
    return (
      <span className="text-[var(--color-fg-dim)]">
        {alt ? `[Image: ${alt}]` : '[Image omitted]'}
      </span>
    )
  },
  li({ node: _node, ...props }) {
    return <li {...props} className="my-0.5 pl-0.5" />
  },
  ol({ node: _node, ...props }) {
    return <ol {...props} className="my-2 list-decimal space-y-0.5 pl-5" />
  },
  p({ node: _node, ...props }) {
    return <p {...props} className="my-2 first:mt-0 last:mb-0" />
  },
  pre({ node: _node, ...props }) {
    return (
      <pre
        {...props}
        className="my-2 overflow-x-auto rounded-lg bg-black/25 p-3 font-mono text-xs leading-5"
      />
    )
  },
  table({ node: _node, ...props }) {
    return (
      <div
        role="region"
        aria-label="Scrollable table"
        tabIndex={0}
        className="my-3 max-w-full overflow-x-auto rounded-lg border border-[var(--color-border)] overscroll-x-contain"
      >
        <table
          {...props}
          className="w-full min-w-full table-auto border-separate border-spacing-0 text-left text-xs leading-5"
        />
      </div>
    )
  },
  td({ node: _node, ...props }) {
    return (
      <td
        {...props}
        className="border-t border-[var(--color-border)] px-3 py-2 align-top [overflow-wrap:normal]"
      />
    )
  },
  th({ node: _node, ...props }) {
    return (
      <th
        {...props}
        className="bg-black/15 px-3 py-2 align-bottom text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-dim)] [overflow-wrap:normal] first:rounded-tl-lg last:rounded-tr-lg"
      />
    )
  },
  ul({ node: _node, ...props }) {
    return <ul {...props} className="my-2 list-disc space-y-0.5 pl-5" />
  },
}

const safeUrlTransform: UrlTransform = (url, key) => {
  if (key === 'src') return ''
  return defaultUrlTransform(url)
}

export function CoachMessageBody({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-sm leading-6 [overflow-wrap:anywhere]">
      <Markdown
        allowedElements={ALLOWED_ELEMENTS}
        components={COMPONENTS}
        remarkPlugins={[remarkGfm, remarkBreaks]}
        unwrapDisallowed
        urlTransform={safeUrlTransform}
      >
        {text}
      </Markdown>
    </div>
  )
}
