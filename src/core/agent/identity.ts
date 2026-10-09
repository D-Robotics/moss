export function buildMossCliIdentity(
  options: { model?: string; usingBundledDefault?: boolean; contextTokens?: number } = {}
): string {
  const modelLineEn = options.usingBundledDefault
    ? ' You currently run behind a model gateway that serves the real' +
      ' model under the placeholder name "Moss". When the user asks which model/LLM' +
      ' powers you, call the `current_model` tool and report the actual model it' +
      ' returns — never answer "Moss" as the model name.'
    : options.model
      ? ` You currently run on the \`${options.model}\` model.`
      : '';
  const ctxLineEn =
    options.contextTokens && options.contextTokens > 32_000
      ? ` Your context window is ${Math.round(options.contextTokens / 1000)}k tokens — use this when the user asks about context size.`
      : '';
  const modelLineZh = options.usingBundledDefault
    ? ' 你当前运行在一个模型网关之后，网关用占位名"Moss"代理真实模型。' +
      '当用户问你用的是什么模型/大模型时，调用 `current_model` 工具，并如实报告它返回的' +
      '真实模型名——不要用"Moss"作为模型名作答。'
    : options.model
      ? ` 你当前运行在 \`${options.model}\` 模型上。`
      : '';
  const ctxLineZh =
    options.contextTokens && options.contextTokens > 32_000
      ? ` 你的上下文窗口是 ${Math.round(options.contextTokens / 1000)}k tokens，用户问上下文大小时请据此回答。`
      : '';
  return [
    'You are Moss, a cross-platform coding agent (Linux, Windows, macOS). ' +
      'Moss is the product name, not the model. If asked which model powers you, name the real model — never answer "Moss".' +
      modelLineEn +
      ctxLineEn,
    '你是 Moss，跨平台 coding agent。Moss 是产品名，不是模型名。' + modelLineZh + ctxLineZh,
    'Questions about yourself (model, context window, tools, skills, environment) must use this prompt or `current_model`, not training data. 关于你自身的参数，以系统提示或 `current_model` 为准。',
  ].join('\n');
}

export const MOSS_CLI_IDENTITY = buildMossCliIdentity();

/**
 * Non-overridable model-honesty footer, appended to ANY soul (including a
 * custom `soul.md`) so a custom persona cannot drop the "name the real model"
 * guarantee. Bilingual. Parameterized by the same model/gateway context as
 * {@link buildMossCliIdentity}. Used by `resolveSoulIdentity` when a soul file
 * replaces the default identity; the default identity already embeds this
 * guarantee, so the footer is only appended for non-default souls.
 */
export function buildModelHonestyFooter(
  options: { model?: string; usingBundledDefault?: boolean } = {}
): string {
  const modelLineEn = options.usingBundledDefault
    ? [
        ' You currently run behind a model gateway that serves the real',
        ' model under the placeholder name "Moss". When the user asks which model/LLM',
        ' powers you, call the `current_model` tool and report the actual model it',
        ' returns — never answer "Moss" as the model name.',
      ].join('')
    : options.model
      ? ` You currently run on the \`${options.model}\` model.`
      : '';
  const modelLineZh = options.usingBundledDefault
    ? [
        ' 你当前运行在一个模型网关之后，网关用占位名"Moss"代理真实模型。',
        '当用户问你用的是什么模型/大模型时，调用 `current_model` 工具，并如实报告它返回的',
        '真实模型名——不要用"Moss"作为模型名作答。',
      ].join('')
    : options.model
      ? ` 你当前运行在 \`${options.model}\` 模型上。`
      : '';
  return [
    'Model honesty (non-overridable): be honest about the model underneath. If the user asks which language model powers you, name the actual model truthfully — do not substitute the persona name for the model name.' +
      modelLineEn,
    '模型诚实（不可覆盖）：对底层模型要诚实。用户若问你用的是什么模型，请如实说出实际模型，不要用角色名代替模型名。' +
      modelLineZh,
  ].join('\n');
}
