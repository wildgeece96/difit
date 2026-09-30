import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { DiffFile, DiffLine } from '../../types/diff';
import { FrontmatterTable } from '../components/FrontmatterTable';
import type { MergedChunk } from '../hooks/useExpandedLines';
import { extractFrontmatter, getFrontmatterLines } from '../utils/frontmatter';
import { computeFrontmatterDiff } from '../utils/frontmatterDiff';
import { isSafeUrl } from '../utils/markdownUtils';

import { getMarkdownComponents } from './markdownComponents';
import { MarkdownSplitPreview } from './MarkdownSplitPreview';
import { DEFAULT_PREVIEW_MODE, PreviewModeTabs, type PreviewMode } from './PreviewModeTabs';
import { TextDiffViewer } from './TextDiffViewer';
import type { DiffViewerBodyProps } from './types';

type PreviewBlockType = 'add' | 'delete' | 'change' | 'context';

type PreviewBlock = {
  type: PreviewBlockType;
  lines: string[];
};

type PreviewLineEntry = {
  type: PreviewBlockType;
  content: string;
};

type MarkdownRenderBlock = {
  kind: 'markdown';
  type: PreviewBlockType;
  lines: string[];
};

type FencedCodeRenderBlock = {
  kind: 'fenced-code';
  lines: PreviewLineEntry[];
};

type PreviewRenderBlock = MarkdownRenderBlock | FencedCodeRenderBlock;

type FenceInfo = {
  marker: '`' | '~';
  length: number;
  raw: string;
};

const isFetchableRef = (ref?: string) => Boolean(ref && ref !== 'stdin');

type PreviewSource = { path: string; ref: string } | null;

type PreviewSourcePair = {
  base: PreviewSource;
  target: PreviewSource;
};

type PreviewContents = {
  base: string | null;
  target: string | null;
};

const isDeletionLine = (line: DiffLine) => line.type === 'delete' || line.type === 'remove';

const isContextLine = (line: DiffLine) => line.type === 'normal' || line.type === 'context';

const appendBlockLine = (blocks: PreviewBlock[], type: PreviewBlockType, line: string) => {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    last.lines.push(line);
    return;
  }
  blocks.push({ type, lines: [line] });
};

const flushDeleteLines = (blocks: PreviewBlock[], pendingDeletes: string[]) => {
  pendingDeletes.forEach((line) => appendBlockLine(blocks, 'delete', line));
  pendingDeletes.length = 0;
};

const buildPreviewBlocks = (chunks: MergedChunk[]): PreviewBlock[] => {
  const blocks: PreviewBlock[] = [];
  const pendingDeletes: string[] = [];
  let inChange = false;

  chunks.forEach((chunk) => {
    chunk.lines.forEach((line) => {
      if (line.type === 'header' || line.type === 'hunk') return;

      if (isDeletionLine(line)) {
        pendingDeletes.push(line.content);
        return;
      }

      if (line.type === 'add') {
        if (pendingDeletes.length > 0) {
          flushDeleteLines(blocks, pendingDeletes);
          inChange = true;
        }
        appendBlockLine(blocks, inChange ? 'change' : 'add', line.content);
        return;
      }

      if (isContextLine(line)) {
        flushDeleteLines(blocks, pendingDeletes);
        inChange = false;
        appendBlockLine(blocks, 'context', line.content);
      }
    });

    flushDeleteLines(blocks, pendingDeletes);
    inChange = false;
  });

  return blocks;
};

const stripCarriageReturn = (line: string) => line.replace(/\r$/, '');

/**
 * Removes the leading YAML frontmatter lines from the diff preview blocks so the
 * `---` delimiters and raw YAML are not rendered as markdown below the dedicated
 * frontmatter table. Deleted lines are matched against the base frontmatter,
 * added/changed lines against the target frontmatter, and context lines against
 * both. Matching is content-verified: as soon as a line no longer matches the
 * expected frontmatter (e.g. the diff starts below the frontmatter, so the first
 * lines are body content), stripping stops and the remaining blocks are kept
 * untouched.
 */
const stripFrontmatterBlocks = (
  blocks: PreviewBlock[],
  baseLines: string[],
  targetLines: string[],
): PreviewBlock[] => {
  if (baseLines.length === 0 && targetLines.length === 0) {
    return blocks;
  }

  let baseIndex = 0;
  let targetIndex = 0;
  let stripping = true;
  const result: PreviewBlock[] = [];

  for (const block of blocks) {
    if (!stripping) {
      result.push(block);
      continue;
    }

    const keptLines: string[] = [];

    for (const rawLine of block.lines) {
      if (!stripping) {
        keptLines.push(rawLine);
        continue;
      }

      const line = stripCarriageReturn(rawLine);
      const baseMatches = baseIndex < baseLines.length && baseLines[baseIndex] === line;
      const targetMatches = targetIndex < targetLines.length && targetLines[targetIndex] === line;

      let matched = false;
      if (block.type === 'delete') {
        matched = baseMatches;
        if (matched) baseIndex += 1;
      } else if (block.type === 'add' || block.type === 'change') {
        matched = targetMatches;
        if (matched) targetIndex += 1;
      } else {
        // context: the line is unchanged, so it must sit within the frontmatter
        // on every side that actually has frontmatter.
        matched =
          (baseLines.length === 0 || baseMatches) && (targetLines.length === 0 || targetMatches);
        if (matched) {
          if (baseMatches) baseIndex += 1;
          if (targetMatches) targetIndex += 1;
        }
      }

      if (!matched) {
        stripping = false;
        keptLines.push(rawLine);
        continue;
      }

      if (baseIndex >= baseLines.length && targetIndex >= targetLines.length) {
        stripping = false;
      }
    }

    if (keptLines.length > 0) {
      result.push({ type: block.type, lines: keptLines });
    }
  }

  return result;
};

const getBlockStyle = (type: PreviewBlockType) => {
  switch (type) {
    case 'add':
      return 'border-l-4 border-diff-addition-border';
    case 'delete':
      return 'border-l-4 border-diff-deletion-border';
    case 'change':
      return 'border-l-4 border-diff-addition-border';
    default:
      return 'border-l-4 border-transparent';
  }
};

const isReferenceDefinitionLine = (line: string) => /^\s*\[[^\]]+\]:\s+\S+/.test(line);

const isFootnoteDefinitionLine = (line: string) => /^\s*\[\^[^\]]+\]:\s+/.test(line);

const isHtmlCommentLine = (line: string) => {
  const trimmedLine = line.trim();
  return (
    trimmedLine.length >= '<!---->'.length &&
    trimmedLine.startsWith('<!--') &&
    trimmedLine.endsWith('-->')
  );
};

const isNonRenderableLine = (line: string) =>
  line.trim() === '' ||
  isReferenceDefinitionLine(line) ||
  isFootnoteDefinitionLine(line) ||
  isHtmlCommentLine(line);

const isPlainPreviewBlock = (lines: string[]) => lines.every(isNonRenderableLine);

const parseFenceStart = (line: string): FenceInfo | null => {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;

  const marker = match[1];
  if (!marker) return null;

  return {
    marker: marker[0] as '`' | '~',
    length: marker.length,
    raw: line,
  };
};

const isFenceEnd = (line: string, fence: FenceInfo) => {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
  if (!match?.[1]) return false;

  return match[1][0] === fence.marker && match[1].length >= fence.length;
};

const buildRenderBlocks = (blocks: PreviewBlock[]): PreviewRenderBlock[] => {
  const renderBlocks: PreviewRenderBlock[] = [];
  let currentMarkdownBlock: MarkdownRenderBlock | null = null;
  let currentFence: { fence: FenceInfo; lines: PreviewLineEntry[] } | null = null;

  const flushMarkdownBlock = () => {
    if (!currentMarkdownBlock) return;
    renderBlocks.push(currentMarkdownBlock);
    currentMarkdownBlock = null;
  };

  const pushMarkdownLine = (type: PreviewBlockType, line: string) => {
    if (currentMarkdownBlock?.type === type) {
      currentMarkdownBlock.lines.push(line);
      return;
    }

    flushMarkdownBlock();
    currentMarkdownBlock = {
      kind: 'markdown',
      type,
      lines: [line],
    };
  };

  const flushFence = (closingFenceLine?: string) => {
    if (!currentFence) return;

    const hasOnlyContextLines = currentFence.lines.every((line) => line.type === 'context');

    if (closingFenceLine && hasOnlyContextLines) {
      pushMarkdownLine('context', currentFence.fence.raw);
      currentFence.lines.forEach((line) => {
        pushMarkdownLine('context', line.content);
      });
      pushMarkdownLine('context', closingFenceLine);
    } else {
      flushMarkdownBlock();
      renderBlocks.push({
        kind: 'fenced-code',
        lines: currentFence.lines,
      });
    }

    currentFence = null;
  };

  blocks.forEach((block) => {
    block.lines.forEach((line) => {
      if (currentFence) {
        if (isFenceEnd(line, currentFence.fence)) {
          flushFence(line);
          return;
        }

        currentFence.lines.push({ type: block.type, content: line });
        return;
      }

      const fence = parseFenceStart(line);
      if (fence) {
        flushMarkdownBlock();
        currentFence = { fence, lines: [] };
        return;
      }

      pushMarkdownLine(block.type, line);
    });
  });

  flushFence();
  flushMarkdownBlock();

  return renderBlocks;
};

const getCodeLineClass = (type: PreviewBlockType) => {
  switch (type) {
    case 'add':
    case 'change':
      return 'border-l-4 border-diff-addition-border bg-diff-addition-bg';
    case 'delete':
      return 'border-l-4 border-diff-deletion-border bg-diff-deletion-bg';
    default:
      return 'border-l-4 border-transparent';
  }
};

const MarkdownDiffPreview = ({
  blocks,
  syntaxTheme,
  baseContent,
  targetContent,
  fileStatus,
  diffStartsAtFileTop,
}: {
  blocks: PreviewBlock[];
  syntaxTheme?: DiffViewerBodyProps['syntaxTheme'];
  baseContent: string | null;
  targetContent: string | null;
  fileStatus: DiffFile['status'];
  diffStartsAtFileTop: boolean;
}) => {
  const components = useMemo(() => getMarkdownComponents(syntaxTheme), [syntaxTheme]);

  const frontmatterView = useMemo(() => {
    const baseAvailable = baseContent !== null;
    const targetAvailable = targetContent !== null;
    const baseData = baseAvailable ? extractFrontmatter(baseContent).data : null;
    const targetData = targetAvailable ? extractFrontmatter(targetContent).data : null;

    // When both sides needed for the diff are available we render a structured
    // table and strip the raw frontmatter lines from the preview blocks below.
    const canDiff =
      fileStatus === 'added'
        ? targetAvailable
        : fileStatus === 'deleted'
          ? baseAvailable
          : baseAvailable && targetAvailable;

    if (canDiff) {
      // Stripping only applies when the diff actually reaches the top of the
      // file; otherwise leading body lines that merely look like frontmatter
      // (e.g. a `---` horizontal rule) would be stripped by mistake.
      const stripBaseLines =
        !diffStartsAtFileTop || fileStatus === 'added'
          ? []
          : getFrontmatterLines(baseContent ?? '');
      const stripTargetLines =
        !diffStartsAtFileTop || fileStatus === 'deleted'
          ? []
          : getFrontmatterLines(targetContent ?? '');
      const baseInput = fileStatus === 'added' ? null : baseData;
      const targetInput = fileStatus === 'deleted' ? null : targetData;
      const entries = computeFrontmatterDiff(baseInput, targetInput);
      const hasFrontmatterChanges = entries.some((entry) => entry.status !== 'unchanged');
      const view = hasFrontmatterChanges ? (
        <FrontmatterTable mode="diff" entries={entries} label="Frontmatter" />
      ) : null;
      return { view, stripBaseLines, stripTargetLines };
    }

    // partial fetch failure or stdin — snapshot fallback with explanatory label.
    // The raw frontmatter lines are retained in the preview blocks.
    if (targetAvailable && targetData !== null) {
      return {
        view: (
          <FrontmatterTable
            mode="snapshot"
            data={targetData}
            label="Frontmatter (target only — base unavailable)"
          />
        ),
        stripBaseLines: [] as string[],
        stripTargetLines: [] as string[],
      };
    }
    if (baseAvailable && baseData !== null) {
      return {
        view: (
          <FrontmatterTable
            mode="snapshot"
            data={baseData}
            label="Frontmatter (base only — target unavailable)"
          />
        ),
        stripBaseLines: [] as string[],
        stripTargetLines: [] as string[],
      };
    }

    return { view: null, stripBaseLines: [] as string[], stripTargetLines: [] as string[] };
  }, [baseContent, targetContent, fileStatus, diffStartsAtFileTop]);

  const renderBlocks = useMemo(
    () =>
      buildRenderBlocks(
        stripFrontmatterBlocks(
          blocks,
          frontmatterView.stripBaseLines,
          frontmatterView.stripTargetLines,
        ),
      ),
    [blocks, frontmatterView.stripBaseLines, frontmatterView.stripTargetLines],
  );

  return (
    <div className="space-y-4">
      {frontmatterView.view}
      {renderBlocks.map((block, index) => {
        if (block.kind === 'fenced-code') {
          return (
            <div key={`preview-block-${index}`} className="px-4">
              <div className="markdown-preview-code overflow-x-auto rounded border border-github-border bg-github-bg-secondary text-sm font-mono text-github-text-primary">
                {block.lines.map((line, lineIndex) => (
                  <div
                    key={`preview-code-line-${index}-${lineIndex}`}
                    className={`${getCodeLineClass(line.type)} whitespace-pre px-3 py-1`}
                  >
                    {line.content || ' '}
                  </div>
                ))}
              </div>
            </div>
          );
        }

        const rawContent = block.lines.join('\n');
        const trimmedContent = rawContent.trim();
        if (!trimmedContent) return null;
        const renderAsPlain = isPlainPreviewBlock(block.lines);
        return (
          <div key={`preview-block-${index}`} className={`px-4 ${getBlockStyle(block.type)}`}>
            {renderAsPlain ? (
              <pre className="whitespace-pre-wrap text-sm text-github-text-primary font-mono">
                {trimmedContent}
              </pre>
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                urlTransform={(url) => (isSafeUrl(url) ? url : '')}
                components={components}
              >
                {trimmedContent}
              </ReactMarkdown>
            )}
          </div>
        );
      })}
    </div>
  );
};

const MarkdownFullPreview = ({
  content,
  syntaxTheme,
}: {
  content: string;
  syntaxTheme?: DiffViewerBodyProps['syntaxTheme'];
}) => {
  const components = useMemo(() => getMarkdownComponents(syntaxTheme), [syntaxTheme]);
  const { data: frontmatter, content: body } = useMemo(
    () => extractFrontmatter(content),
    [content],
  );

  return (
    <div className="space-y-4">
      <FrontmatterTable mode="snapshot" data={frontmatter} />
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (isSafeUrl(url) ? url : '')}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
};

export function MarkdownDiffViewer(props: DiffViewerBodyProps) {
  const { file, baseCommitish, targetCommitish, mergedChunks, syntaxTheme, diffVersion } = props;
  // App owns the remembered mode when it passes a change handler; otherwise the passed
  // mode is only the starting tab.
  const { markdownPreviewMode, onMarkdownPreviewModeChange } = props;
  const [localMode, setLocalMode] = useState<PreviewMode>(
    markdownPreviewMode ?? DEFAULT_PREVIEW_MODE,
  );
  const mode = onMarkdownPreviewModeChange
    ? (markdownPreviewMode ?? DEFAULT_PREVIEW_MODE)
    : localMode;
  const handleModeChange = onMarkdownPreviewModeChange ?? setLocalMode;
  const [contents, setContents] = useState<PreviewContents>({ base: null, target: null });
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [partialFailureLabel, setPartialFailureLabel] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ sourcesKey: string; fetchKey: string } | null>(null);
  const loadedSourcesKey = loaded?.sourcesKey ?? null;
  const previewBlocks = useMemo(() => buildPreviewBlocks(mergedChunks), [mergedChunks]);
  // Frontmatter can only appear in the diff when the first chunk starts at the
  // top of the file; a chunk starting mid-file must be body content even if its
  // leading lines happen to match the frontmatter (e.g. a `---` horizontal rule).
  const diffStartsAtFileTop = useMemo(() => {
    const firstChunk = mergedChunks[0];
    return firstChunk !== undefined && (firstChunk.oldStart <= 1 || firstChunk.newStart <= 1);
  }, [mergedChunks]);

  const previewSources = useMemo<PreviewSourcePair>(() => {
    const target: PreviewSource =
      file.status === 'deleted'
        ? null
        : targetCommitish
          ? { path: file.path, ref: targetCommitish }
          : null;

    const base: PreviewSource =
      file.status === 'added'
        ? null
        : baseCommitish
          ? { path: file.oldPath || file.path, ref: baseCommitish }
          : null;

    return { base, target };
  }, [baseCommitish, targetCommitish, file.path, file.oldPath, file.status]);

  const previewSourcesKey = useMemo(() => {
    const baseKey = previewSources.base
      ? `${previewSources.base.ref}:${previewSources.base.path}`
      : '';
    const targetKey = previewSources.target
      ? `${previewSources.target.ref}:${previewSources.target.path}`
      : '';
    if (!baseKey && !targetKey) return null;
    return `${baseKey}|${targetKey}`;
  }, [previewSources]);

  // A reload of the diff (watch mode) must refetch working-tree content even though the
  // refs and paths are unchanged.
  const previewFetchKey = previewSourcesKey ? `${previewSourcesKey}#${diffVersion ?? 0}` : null;

  const fetchableSources = useMemo<PreviewSourcePair>(
    () => ({
      base:
        previewSources.base && isFetchableRef(previewSources.base.ref) ? previewSources.base : null,
      target:
        previewSources.target && isFetchableRef(previewSources.target.ref)
          ? previewSources.target
          : null,
    }),
    [previewSources],
  );

  useEffect(() => {
    const { base: baseSource, target: targetSource } = fetchableSources;

    if (!previewSourcesKey || !previewFetchKey || (!baseSource && !targetSource)) {
      setContents({ base: null, target: null });
      setLoaded(null);
      setPreviewError(null);
      setPartialFailureLabel(null);
      setIsPreviewLoading(false);
      return;
    }

    let isCanceled = false;

    const fetchBlob = async (source: PreviewSource): Promise<string | null> => {
      if (!source) return null;
      const encodedPath = encodeURIComponent(source.path);
      const response = await fetch(
        `/api/blob/${encodedPath}?ref=${encodeURIComponent(source.ref)}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch preview: ${response.statusText}`);
      }
      return response.text();
    };

    const run = async () => {
      if (previewSourcesKey !== loadedSourcesKey) {
        setContents({ base: null, target: null });
      }
      setIsPreviewLoading(true);
      setPreviewError(null);

      const [baseResult, targetResult] = await Promise.allSettled([
        fetchBlob(baseSource),
        fetchBlob(targetSource),
      ]);

      if (isCanceled) return;

      const nextBase = baseResult.status === 'fulfilled' ? baseResult.value : null;
      const nextTarget = targetResult.status === 'fulfilled' ? targetResult.value : null;

      const failures: string[] = [];
      if (baseSource && baseResult.status === 'rejected') {
        failures.push(
          baseResult.reason instanceof Error ? baseResult.reason.message : 'base fetch failed',
        );
      }
      if (targetSource && targetResult.status === 'rejected') {
        failures.push(
          targetResult.reason instanceof Error
            ? targetResult.reason.message
            : 'target fetch failed',
        );
      }

      setContents({ base: nextBase, target: nextTarget });
      setLoaded({ sourcesKey: previewSourcesKey, fetchKey: previewFetchKey });

      const baseFailed = baseSource !== null && baseResult.status === 'rejected';
      const targetFailed = targetSource !== null && targetResult.status === 'rejected';
      const allFailed =
        (baseSource ? baseFailed : true) &&
        (targetSource ? targetFailed : true) &&
        failures.length > 0;

      setPreviewError(allFailed ? failures.join('; ') : null);

      if (allFailed) {
        setPartialFailureLabel(null);
      } else if (baseFailed) {
        setPartialFailureLabel('Base content unavailable — showing partial preview.');
      } else if (targetFailed) {
        setPartialFailureLabel('Target content unavailable — showing partial preview.');
      } else {
        setPartialFailureLabel(null);
      }

      setIsPreviewLoading(false);
    };

    const relevantContent = file.status === 'deleted' ? contents.base : contents.target;

    if (previewFetchKey !== loaded?.fetchKey || relevantContent === null) {
      void run();
    } else {
      setIsPreviewLoading(false);
    }

    return () => {
      isCanceled = true;
    };
  }, [
    contents.base,
    contents.target,
    fetchableSources,
    file.status,
    loaded,
    loadedSourcesKey,
    previewFetchKey,
    previewSourcesKey,
  ]);

  const fullPreviewContent = useMemo(
    () => (file.status === 'deleted' ? contents.base : contents.target),
    [contents.base, contents.target, file.status],
  );

  const hasFullPreview = useMemo(
    () => previewSourcesKey === loadedSourcesKey && fullPreviewContent !== null,
    [fullPreviewContent, loadedSourcesKey, previewSourcesKey],
  );

  const hasSplitPreview =
    (file.status === 'added' || fetchableSources.base !== null) &&
    (file.status === 'deleted' || fetchableSources.target !== null);
  const isPreviewPending =
    (fetchableSources.base !== null || fetchableSources.target !== null) &&
    (isPreviewLoading || loadedSourcesKey !== previewSourcesKey);
  const isSplitPreviewReady =
    loadedSourcesKey === previewSourcesKey &&
    (file.status === 'added' || contents.base !== null) &&
    (file.status === 'deleted' || contents.target !== null);

  // A remembered mode may not fit this file (e.g. stdin has no blobs), so fall back
  // without overwriting the stored choice.
  const effectiveMode: PreviewMode =
    mode === 'split-preview' && !hasSplitPreview
      ? 'diff'
      : mode === 'full-preview' && !hasFullPreview && !isPreviewPending
        ? 'diff-preview'
        : mode;

  return (
    <div className="bg-github-bg-primary">
      <div className="flex items-center justify-between border-b border-github-border px-4 py-2">
        <PreviewModeTabs
          mode={effectiveMode}
          hasFullPreview={hasFullPreview}
          hasSplitPreview={hasSplitPreview}
          onModeChange={handleModeChange}
        />
      </div>

      {effectiveMode === 'diff' && <TextDiffViewer {...props} />}

      {effectiveMode === 'split-preview' &&
        (isSplitPreviewReady ? (
          <MarkdownSplitPreview
            filePath={file.path}
            baseContent={file.status === 'added' ? null : contents.base}
            targetContent={file.status === 'deleted' ? null : contents.target}
            baseLabel={baseCommitish}
            targetLabel={targetCommitish}
            threads={props.threads}
            showAuthorBadges={props.showAuthorBadges}
            syntaxTheme={syntaxTheme}
            onAddComment={props.onAddComment}
            onGenerateThreadPrompt={props.onGenerateThreadPrompt}
            onRemoveThread={props.onRemoveThread}
            onReplyToThread={props.onReplyToThread}
            onRemoveMessage={props.onRemoveMessage}
            onUpdateMessage={props.onUpdateMessage}
          />
        ) : (
          <div className="p-4 text-sm text-github-text-muted">
            {isPreviewPending
              ? 'Loading preview...'
              : (previewError ?? partialFailureLabel ?? 'Preview unavailable.')}
          </div>
        ))}

      {effectiveMode === 'diff-preview' && (
        <div className="p-4">
          {partialFailureLabel && (
            <div className="text-sm text-github-text-muted mb-3">{partialFailureLabel}</div>
          )}
          <MarkdownDiffPreview
            blocks={previewBlocks}
            syntaxTheme={syntaxTheme}
            baseContent={contents.base}
            targetContent={contents.target}
            fileStatus={file.status}
            diffStartsAtFileTop={diffStartsAtFileTop}
          />
        </div>
      )}

      {effectiveMode === 'full-preview' && (
        <div className="p-4">
          {isPreviewLoading && (
            <div className="text-sm text-github-text-muted mb-3">Loading preview...</div>
          )}
          {previewError && <div className="text-sm text-github-danger mb-3">{previewError}</div>}
          {partialFailureLabel && (
            <div className="text-sm text-github-text-muted mb-3">{partialFailureLabel}</div>
          )}
          {!isPreviewLoading && !previewError && fullPreviewContent !== null && (
            <MarkdownFullPreview content={fullPreviewContent} syntaxTheme={syntaxTheme} />
          )}
          {!isPreviewLoading && !previewError && fullPreviewContent === null && (
            <div className="text-sm text-github-text-muted">Preview unavailable.</div>
          )}
        </div>
      )}
    </div>
  );
}
