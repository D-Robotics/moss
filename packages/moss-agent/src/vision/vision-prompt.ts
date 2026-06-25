/**
 * Vision system prompt builder — injects vision-specific guidance into the system prompt
 * when the agent has access to vision tools.
 *
 * @public
 */

export interface VisionPromptOptions {
  /** Whether the agent has vision analysis capability available. */
  visionEnabled?: boolean;
  /** Whether to include screenshot guidance specifically. */
  screenshotGuidance?: boolean;
}

/**
 * Build a vision-specific system prompt fragment.
 *
 * Injects guidance on when and how to use vision analysis tools,
 * so the model knows it can "see" images and screenshots.
 *
 * @public
 */
export function buildVisionSystemPrompt(options: VisionPromptOptions = {}): string {
  if (!options.visionEnabled) return '';

  const lines: string[] = [];

  lines.push('## Vision Analysis Capability');
  lines.push('');
  lines.push('You have access to the `vision_analyze` tool for analyzing images and screenshots.');
  lines.push('');
  lines.push('**When to use vision analysis:**');
  lines.push('- The user asks you to look at an image, screenshot, or photo');
  lines.push('- You need to understand a UI, diagram, chart, or visual layout');
  lines.push('- The user references "this image", "the screenshot", "what do you see"');
  lines.push('- You need to extract text from an image (OCR via vision)');
  lines.push('- Debugging UI issues or verifying visual output');
  lines.push('');

  if (options.screenshotGuidance) {
    lines.push('**Screenshot guidance:**');
    lines.push('- When asked about the current screen, ask the user to provide a screenshot path');
    lines.push('- Screenshots are typically PNG files in the workspace');
    lines.push('- Use `vision_analyze` with a specific question for best results');
    lines.push('- For UI analysis, ask about layout, colors, text content, and interactive elements');
    lines.push('');
  }

  lines.push('**Best practices:**');
  lines.push('- Always provide a specific question to get focused, useful answers');
  lines.push('- For complex images, break down your analysis into multiple focused questions');
  lines.push('- Use "high" detail for diagrams, text-heavy images, and UI screenshots');
  lines.push('- Use "low" detail for quick checks or simple images');
  lines.push('');

  return lines.join('\n');
}
