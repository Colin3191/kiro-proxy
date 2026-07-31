const BUDGET_EFFORT_THRESHOLDS = [
  [2048, 'low'],
  [8192, 'medium'],
  [16384, 'high'],
  [32768, 'xhigh'],
];

function budgetToEffort(budgetTokens) {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return undefined;
  return BUDGET_EFFORT_THRESHOLDS.find(([limit]) => budgetTokens <= limit)?.[1] || 'max';
}

export function normalizeResponsesModelOptions(body = {}) {
  const effort = typeof body.reasoning?.effort === 'string' ? body.reasoning.effort : undefined;
  return effort ? { effort } : undefined;
}

export function normalizeChatCompletionsModelOptions(body = {}) {
  const effort = typeof body.reasoning_effort === 'string'
    ? body.reasoning_effort
    : (typeof body.reasoning?.effort === 'string' ? body.reasoning.effort : undefined);
  return effort ? { effort } : undefined;
}

export function normalizeAnthropicModelOptions(body = {}) {
  const explicitEffort = typeof body.output_config?.effort === 'string' ? body.output_config.effort : undefined;
  const thinking = body.thinking && typeof body.thinking === 'object' ? body.thinking : undefined;
  let thinkingType;
  if (thinking?.type === 'enabled' || thinking?.type === 'adaptive') thinkingType = 'adaptive';
  else if (thinking?.type === 'disabled') thinkingType = 'disabled';

  const display = typeof thinking?.display === 'string' ? thinking.display : undefined;
  const effort = explicitEffort || budgetToEffort(thinking?.budget_tokens);
  if (!effort && !thinkingType && !display) return undefined;
  return { effort, thinkingType, display };
}

function effortCapability(schema) {
  for (const path of ['output_config', 'reasoning']) {
    const effort = schema?.properties?.[path]?.properties?.effort;
    if (Array.isArray(effort?.enum) && effort.enum.length > 0) {
      return { path, levels: effort.enum, defaultLevel: effort.default || effort.enum[0] };
    }
  }
  return undefined;
}

function thinkingCapability(schema) {
  const thinking = schema?.properties?.thinking;
  if (!thinking || typeof thinking !== 'object') return undefined;
  return {
    types: Array.isArray(thinking.properties?.type?.enum) ? thinking.properties.type.enum : [],
    displays: Array.isArray(thinking.properties?.display?.enum) ? thinking.properties.display.enum : [],
  };
}

function normalizeEffort(effort, levels) {
  if (!effort) return undefined;
  if (levels.includes(effort)) return effort;
  if (effort === 'minimal') {
    if (levels.includes('none')) return 'none';
    if (levels.includes('low')) return 'low';
  }
  return undefined;
}

export function resolveAdditionalModelRequestFields(schema, options) {
  if (!schema || typeof schema !== 'object' || !options) return undefined;
  const effort = effortCapability(schema);
  const thinking = thinkingCapability(schema);
  const fields = {};

  let thinkingType = options.thinkingType;
  const disablesViaEffort = options.effort === 'none'
    && effort && !effort.levels.includes('none') && thinking?.types.includes('disabled');
  if (disablesViaEffort) thinkingType = 'disabled';

  if (thinking) {
    const type = thinking.types.includes(thinkingType)
      ? thinkingType
      : (options.display && thinking.types.includes('adaptive') ? 'adaptive' : undefined);
    const display = thinking.displays.includes(options.display) ? options.display : undefined;
    if (type) fields.thinking = { type, ...(display && { display }) };
  }

  if (effort && thinkingType !== 'disabled') {
    const requested = normalizeEffort(options.effort, effort.levels);
    const selected = requested || (options.effort ? effort.defaultLevel : undefined);
    if (selected) fields[effort.path] = { effort: selected };
  }

  return Object.keys(fields).length > 0 ? fields : undefined;
}
