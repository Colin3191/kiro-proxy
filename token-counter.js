import { encodingForModel } from 'js-tiktoken';

const enc = encodingForModel('gpt-4o');

function countText(text) {
  if (!text) return 0;
  return enc.encode(text).length;
}

export function countMessages(messages, system) {
  let tokens = 0;
  if (system) tokens += countText(typeof system === 'string' ? system : JSON.stringify(system));
  for (const msg of messages || []) {
    tokens += 4; // role + structural overhead
    if (typeof msg.content === 'string') {
      tokens += countText(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') tokens += countText(block.text);
        else if (block.type === 'tool_result') tokens += countText(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
        else if (block.type === 'tool_use') tokens += countText(JSON.stringify(block.input));
      }
    }
  }
  return tokens;
}

export function countContent(content) {
  if (typeof content === 'string') return countText(content);
  let tokens = 0;
  for (const block of content || []) {
    if (block.type === 'text') tokens += countText(block.text);
    else if (block.type === 'tool_use') tokens += countText(JSON.stringify(block.input));
    else if (block.type === 'thinking') tokens += countText(block.thinking);
  }
  return tokens;
}
