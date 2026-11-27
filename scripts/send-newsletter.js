#!/usr/bin/env node

/**
 * Send blog post notifications via Buttondown.
 *
 * Usage:
 *   BUTTONDOWN_API_KEY=xxx node scripts/send-newsletter.js              # send all unsent published posts
 *   node scripts/send-newsletter.js --post whole-engineer               # send one post by slug
 *   node scripts/send-newsletter.js --changed-only                      # only posts changed in last commit (CI)
 *   node scripts/send-newsletter.js --dry-run                           # preview without sending
 *   node scripts/send-newsletter.js --list                              # show unsent posts
 *   node scripts/send-newsletter.js --force --post whole-engineer       # resend even if already sent
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { fileURLToPath } from 'url';
import { BLOG_POST_FILES } from '../src/config/blogPosts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SITE_URL = process.env.SITE_URL || 'https://www.jiabinlu.com';
const BUTTONDOWN_API = 'https://api.buttondown.com/v1/emails';
const BLOG_POSTS_DIR = path.join(__dirname, '..', 'public', 'blog-posts');
const SENT_STATE_FILE = path.join(__dirname, '.newsletter-sent.json');

// Gmail clips messages over ~102KB of HTML. Buttondown's template adds ~15-20KB,
// so the article body gets this budget before it is truncated with a "read more" link.
// Typical posts render to 15-40KB, so nearly all go out in full.
const MAX_BODY_HTML_BYTES = 70_000;

function parseArgs(argv) {
  const args = {
    post: null,
    dryRun: false,
    draft: false,
    force: false,
    changedOnly: false,
    list: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--draft') args.draft = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--changed-only') args.changedOnly = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--post' && argv[i + 1]) {
      args.post = argv[++i].replace(/\.md$/, '');
    } else if (!arg.startsWith('-')) {
      args.post = arg.replace(/\.md$/, '');
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Send blog post notifications via Buttondown.

Options:
  --post <slug>     Send notification for a specific post
  --changed-only    Only posts changed in the pushed commit range (for CI)
  --all             Send all unsent posts (default: newest only)
  --dry-run         Preview email without sending
  --draft           Create a Buttondown draft (not sent, sent state untouched)
  --force           Send even if already marked as sent
  --list            List unsent published posts
  --help            Show this help

Environment:
  BUTTONDOWN_API_KEY   Required unless --dry-run or --list
  SITE_URL             Default: ${SITE_URL}
`);
}

function loadSentState() {
  if (!fs.existsSync(SENT_STATE_FILE)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(SENT_STATE_FILE, 'utf-8'));
  } catch {
    console.warn('Warning: could not parse newsletter sent state, starting fresh.');
    return {};
  }
}

function saveSentState(state) {
  fs.writeFileSync(SENT_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function getChangedPostFiles() {
  try {
    const base = process.env.GITHUB_EVENT_BEFORE || 'HEAD~1';
    const head = process.env.GITHUB_SHA || 'HEAD';
    const output = execSync(
      `git -c core.quotePath=false diff --name-only -z ${base} ${head} -- public/blog-posts/`,
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    if (!output) return [];
    return output
      .split('\0')
      .map((line) => path.basename(line.trim()))
      .filter((name) => name.endsWith('.md'));
  } catch {
    return [];
  }
}

function loadPost(fileName) {
  const filePath = path.join(BLOG_POSTS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Post file not found: ${fileName}`);
  }

  const { data, content } = matter(fs.readFileSync(filePath, 'utf-8'));
  const slug = fileName.replace(/\.md$/, '');

  return {
    slug,
    fileName,
    title: data.title || slug,
    date: data.date || null,
    category: data.category || 'General',
    excerpt: data.excerpt || extractExcerpt(content),
    content,
    published: data.published !== false,
    url: `${SITE_URL}/blog/${slug}`,
  };
}

function extractExcerpt(content) {
  const paragraph = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('![') && !line.startsWith('---'));

  if (!paragraph) return '';
  return paragraph.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 280);
}

// Inline styles keep the layout tight in every client (Gmail drops <style> in many cases).
const FONT = "font-size:16px;line-height:1.7;color:#1f2328";
const STYLES = {
  p: `margin:0 0 12px;${FONT}`,
  h1: 'margin:24px 0 8px;font-size:21px;line-height:1.4;color:#111',
  h2: 'margin:24px 0 8px;font-size:19px;line-height:1.4;color:#111',
  h3: 'margin:20px 0 6px;font-size:17px;line-height:1.4;color:#111',
  h4: 'margin:16px 0 6px;font-size:16px;line-height:1.4;color:#111',
  ul: `margin:0 0 12px;padding-left:22px;${FONT}`,
  ol: `margin:0 0 12px;padding-left:22px;${FONT}`,
  li: 'margin:0 0 4px',
  blockquote: 'margin:0 0 12px;padding:2px 0 2px 12px;border-left:3px solid #d0d7de;color:#57606a',
  hr: 'margin:20px 0;border:0;border-top:1px solid #e5e7eb',
  img: 'display:block;max-width:100%;height:auto;margin:4px auto 12px;border-radius:6px',
  a: 'color:#0969da',
  pre: 'margin:0 0 12px;padding:10px 12px;background:#f6f8fa;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.5',
  code: 'font-family:Menlo,Consolas,monospace;font-size:0.9em',
  table: 'border-collapse:collapse;margin:0 0 12px;font-size:14px',
  th: 'border:1px solid #d0d7de;padding:4px 8px;background:#f6f8fa',
  td: 'border:1px solid #d0d7de;padding:4px 8px',
};
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input']);
const SKIP_PROPS = new Set(['className', 'dataFootnoteRef', 'dataFootnoteBackref', 'dataFootnotes', 'ariaDescribedBy', 'ariaLabel', 'id']);

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function absoluteUrl(url) {
  if (typeof url !== 'string') return url;
  if (url.startsWith('/') && !url.startsWith('//')) return `${SITE_URL}${url}`;
  return url;
}

function hastToHtml(node, parent) {
  if (node.type === 'root') return node.children.map((child) => hastToHtml(child, node)).join('');
  if (node.type === 'text') {
    // remark-rehype emits "\n" text nodes between blocks; drop them so the HTML has no blank
    // lines (Buttondown parses the body as markdown, and a blank line would end the HTML block).
    if (parent && parent.type !== 'element') return node.value.trim() ? escapeHtml(node.value) : '';
    if (/^\s*$/.test(node.value) && parent && ['ul', 'ol', 'table', 'thead', 'tbody', 'tr', 'blockquote'].includes(parent.tagName)) return '';
    return escapeHtml(node.value).replace(/\n/g, parent?.tagName === 'code' ? '\n' : ' ');
  }
  if (node.type !== 'element') return '';

  const tag = node.tagName;
  const props = { ...node.properties };
  const attrs = [];

  if (tag === 'a') props.href = absoluteUrl(props.href);
  if (tag === 'img') props.src = absoluteUrl(props.src);
  // Inline <code> inside <pre> keeps the <pre> styling only.
  const style = tag === 'code' && parent?.tagName === 'pre' ? STYLES.code : STYLES[tag];
  if (style) attrs.push(`style="${style}"`);

  for (const [key, value] of Object.entries(props)) {
    if (SKIP_PROPS.has(key) || value === undefined || value === null || value === false) continue;
    const name = key.toLowerCase();
    attrs.push(value === true ? name : `${name}="${escapeHtml(Array.isArray(value) ? value.join(' ') : value)}"`);
  }

  const open = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  if (VOID_TAGS.has(tag)) return open;
  return `${open}${node.children.map((child) => hastToHtml(child, node)).join('')}</${tag}>`;
}

function markdownToBlocks(markdown) {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
  const tree = processor.runSync(processor.parse(markdown));
  // A paragraph holding only an image renders as a bare block image (no extra <p> margin).
  return tree.children
    .filter((node) => node.type === 'element')
    .map((node) => {
      const kids = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
      if (node.tagName === 'p' && kids.length === 1 && kids[0].tagName === 'img') return hastToHtml(kids[0], node);
      return hastToHtml(node, tree);
    });
}

function buildEmailBody(post) {
  const blocks = markdownToBlocks(post.content);

  let truncated = false;
  let size = 0;
  const kept = [];
  for (const block of blocks) {
    size += Buffer.byteLength(block, 'utf-8');
    if (size > MAX_BODY_HTML_BYTES && kept.length > 0) {
      truncated = true;
      break;
    }
    kept.push(block);
  }

  // Strip a trailing <hr> so the footer link does not sit under a double divider.
  while (kept.length && kept[kept.length - 1].startsWith('<hr')) kept.pop();

  const footer = truncated
    ? `<p style="margin:16px 0 0;${FONT}"><a style="${STYLES.a};font-weight:600" href="${post.url}">继续阅读全文 →</a></p>`
    : `<p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#6e7781">在网站上阅读、分享或留言：<a style="${STYLES.a}" href="${post.url}">jiabinlu.com</a></p>`;

  // One line, no blank lines: Buttondown treats the whole body as a single raw-HTML block.
  return `<div>${kept.join('')}${footer}</div>`;
}

async function sendViaButtondown({ subject, body, dryRun, draft }) {
  if (dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log(`Subject: ${subject}`);
    console.log('Body:\n');
    console.log(body);
    console.log('--- END ---\n');
    return { id: 'dry-run', status: 'dry_run' };
  }

  const apiKey = process.env.BUTTONDOWN_API_KEY;
  if (!apiKey) {
    throw new Error('BUTTONDOWN_API_KEY is required');
  }

  const response = await fetch(BUTTONDOWN_API, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
      'X-API-Version': '2026-04-01',
      'X-Buttondown-Live-Dangerously': 'true',
    },
    body: JSON.stringify({
      subject,
      body,
      status: draft ? 'draft' : 'about_to_send',
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = payload.detail || payload.message || JSON.stringify(payload);
    throw new Error(`Buttondown API error (${response.status}): ${detail}`);
  }

  return payload;
}

function selectPosts({ args, sentState }) {
  const registered = new Set(BLOG_POST_FILES);

  let candidates = BLOG_POST_FILES.filter((fileName) => registered.has(fileName));

  if (args.changedOnly) {
    const changed = getChangedPostFiles();
    if (changed.length === 0) {
      console.log('No blog post files changed in the last commit.');
      return [];
    }
    candidates = candidates.filter((fileName) => changed.includes(fileName));
    console.log(`Changed in last commit: ${changed.join(', ')}`);
  }

  const posts = candidates
    .map((fileName) => loadPost(fileName))
    .filter((post) => post.published);

  if (args.post) {
    const match = posts.find((post) => post.slug === args.post);
    if (!match) {
      throw new Error(`Published post not found: ${args.post}`);
    }
    return [match];
  }

  return posts
    .filter((post) => args.force || !sentState[post.slug])
    .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
    .slice(0, args.all || args.changedOnly || args.post ? undefined : 1);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  const sentState = loadSentState();
  const posts = selectPosts({ args, sentState });

  if (args.list) {
    if (posts.length === 0) {
      console.log('No unsent published posts.');
      return;
    }

    for (const post of posts) {
      console.log(`- ${post.slug} (${post.date || 'no date'}) — ${post.title}`);
    }
    return;
  }

  if (posts.length === 0) {
    console.log('Nothing to send.');
    return;
  }

  if (!args.dryRun && !process.env.BUTTONDOWN_API_KEY) {
    throw new Error('BUTTONDOWN_API_KEY is required (or use --dry-run)');
  }

  let sentCount = 0;

  for (const post of posts) {
    const subject = post.title;
    const body = buildEmailBody(post);

    console.log(`Sending: ${post.slug} — ${post.title}`);

    const result = await sendViaButtondown({ subject, body, dryRun: args.dryRun, draft: args.draft });

    if (args.draft) {
      console.log(`📝 Draft created (${result.id || 'ok'}) — review it in Buttondown, nothing was sent.`);
    } else if (!args.dryRun) {
      sentState[post.slug] = {
        sentAt: new Date().toISOString(),
        emailId: result.id || null,
        subject,
        url: post.url,
      };
      saveSentState(sentState);
      sentCount += 1;
      console.log(`✅ Sent (${result.id || 'ok'})`);
    }
  }

  if (args.dryRun) {
    console.log(`Dry run complete for ${posts.length} post(s).`);
  } else {
    console.log(`Done. Sent ${sentCount} newsletter notification(s).`);
  }
}

main().catch((error) => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
