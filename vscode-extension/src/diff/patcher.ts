export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

export class Patcher {
  /**
   * Parses standard SEARCH/REPLACE blocks formatted like:
   * <<<<<<< SEARCH
   * ...
   * =======
   * ...
   * >>>>>>> REPLACE
   * Handles variations with trailing spaces, periods, backticks, or inconsistent marker lengths.
   */
  public static parseBlocks(aiOutput: string): SearchReplaceBlock[] {
    const blocks: SearchReplaceBlock[] = [];
    // Flexible regex allowing 5-9 angle brackets, optional trailing characters on marker lines
    const blockRegex = /<{5,9}\s*SEARCH[^\r\n]*\r?\n([\s\S]*?)\r?\n={5,9}[^\r\n]*\r?\n([\s\S]*?)\r?\n>{5,9}\s*REPLACE[^\r\n]*/gi;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(aiOutput)) !== null) {
      const search = match[1];
      const replace = match[2];
      // Skip empty or instructions template blocks
      if (search.trim() === 'exact lines to find in original file') {
        continue;
      }
      blocks.push({
        search,
        replace
      });
    }

    return blocks;
  }

  /**
   * Applies the blocks to the original text.
   * Uses multi-tier matching:
   * 1. Exact substring match
   * 2. Line-ending normalized match
   * 3. Trimmed lines match with indentation preservation
   */
  public static applyBlocks(originalText: string, blocks: SearchReplaceBlock[]): { updatedText: string; appliedCount: number } {
    const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
    let currentText = originalText.replace(/\r\n/g, '\n');
    let appliedCount = 0;

    for (const block of blocks) {
      const search = block.search.replace(/\r\n/g, '\n');
      const replace = block.replace.replace(/\r\n/g, '\n');

      // Tier 1: Direct match in normalized text
      if (currentText.includes(search)) {
        currentText = currentText.replace(search, replace);
        appliedCount++;
        continue;
      }

      // Tier 2: Line-trimmed matching (handles indentation or tabs vs spaces differences)
      const currentLines = currentText.split('\n');
      const searchLines = search.split('\n');
      const replaceLines = replace.split('\n');

      let matchIndex = -1;
      for (let i = 0; i <= currentLines.length - searchLines.length; i++) {
        let allMatch = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (currentLines[i + j].trim() !== searchLines[j].trim()) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          matchIndex = i;
          break;
        }
      }

      if (matchIndex !== -1) {
        // Detect indentation of the matched line in original file
        const targetIndent = currentLines[matchIndex].match(/^[\t ]*/)?.[0] || '';
        // Detect search block base indentation
        const firstNonEmptySearch = searchLines.find(l => l.trim().length > 0) || '';
        const searchIndent = firstNonEmptySearch.match(/^[\t ]*/)?.[0] || '';

        // Adjust replacement lines to match the file's indentation
        const adjustedReplaceLines = replaceLines.map(line => {
          if (line.trim().length === 0) return '';
          if (searchIndent.length > 0 && line.startsWith(searchIndent)) {
            return targetIndent + line.slice(searchIndent.length);
          }
          return targetIndent + line.trimStart();
        });

        currentLines.splice(matchIndex, searchLines.length, ...adjustedReplaceLines);
        currentText = currentLines.join('\n');
        appliedCount++;
        continue;
      }

      // Tier 3: Relaxed match (ignoring empty lines differences in search block)
      const nonBlankSearch = searchLines.filter(l => l.trim().length > 0);
      if (nonBlankSearch.length > 0) {
        for (let i = 0; i <= currentLines.length - nonBlankSearch.length; i++) {
          let allMatch = true;
          for (let j = 0; j < nonBlankSearch.length; j++) {
            if (currentLines[i + j].trim() !== nonBlankSearch[j].trim()) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            matchIndex = i;
            break;
          }
        }

        if (matchIndex !== -1) {
          const targetIndent = currentLines[matchIndex].match(/^[\t ]*/)?.[0] || '';
          const adjustedReplaceLines = replaceLines.map(line => {
            if (line.trim().length === 0) return '';
            return targetIndent + line.trimStart();
          });
          currentLines.splice(matchIndex, nonBlankSearch.length, ...adjustedReplaceLines);
          currentText = currentLines.join('\n');
          appliedCount++;
        }
      }
    }

    if (eol === '\r\n') {
      currentText = currentText.replace(/\n/g, '\r\n');
    }

    return { updatedText: currentText, appliedCount };
  }
}

