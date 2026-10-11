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
   */
  public static parseBlocks(aiOutput: string): SearchReplaceBlock[] {
    const blocks: SearchReplaceBlock[] = [];
    // Handle CRLF and LF
    const blockRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(aiOutput)) !== null) {
      blocks.push({
        search: match[1],
        replace: match[2]
      });
    }

    return blocks;
  }

  /**
   * Applies the blocks to the original text.
   * Supports both exact matching and trimmed lines fallback.
   */
  public static applyBlocks(originalText: string, blocks: SearchReplaceBlock[]): { updatedText: string; appliedCount: number } {
    let updatedText = originalText;
    let appliedCount = 0;

    for (const block of blocks) {
      if (updatedText.includes(block.search)) {
        updatedText = updatedText.replace(block.search, block.replace);
        appliedCount++;
      } else {
        // Fallback: line-trimmed comparison
        const normalizedOriginal = updatedText.split('\n');
        const searchLines = block.search.split('\n').map(l => l.trimEnd());
        
        // Find line index matching
        let matchIndex = -1;
        for (let i = 0; i <= normalizedOriginal.length - searchLines.length; i++) {
          let allMatch = true;
          for (let j = 0; j < searchLines.length; j++) {
            if (normalizedOriginal[i + j].trimEnd() !== searchLines[j]) {
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
          const originalLines = updatedText.split('\n');
          originalLines.splice(matchIndex, searchLines.length, block.replace);
          updatedText = originalLines.join('\n');
          appliedCount++;
        }
      }
    }

    return { updatedText, appliedCount };
  }
}
