






export interface StructuredOutputPromptOptions {
  
  structuredOutputEnabled?: boolean;
}






export function buildStructuredOutputSystemPrompt(
  options: StructuredOutputPromptOptions = {}
): string {
  if (!options.structuredOutputEnabled) return '';

  const lines: string[] = [];

  lines.push('## Structured Output Generation');
  lines.push('');
  lines.push(
    'You have access to the `generate_structured` tool for producing JSON output with guaranteed format correctness.'
  );
  lines.push('');
  lines.push('**When to use structured output:**');
  lines.push('- The user asks for data in a specific format (JSON, lists, tables as JSON)');
  lines.push('- You need to extract structured information from text or documents');
  lines.push('- You are generating configuration, manifests, or data files');
  lines.push('- You need to produce output that will be consumed programmatically');
  lines.push('- Summarizing or transforming data into a known schema');
  lines.push('');
  lines.push('**How to use `generate_structured`:**');
  lines.push('1. Define a JSON Schema describing the exact output structure');
  lines.push('2. Write a clear prompt describing what data to generate');
  lines.push('3. The tool will validate your output against the schema');
  lines.push('4. If validation fails, fix the errors and try again');
  lines.push('');
  lines.push('**Schema design tips:**');
  lines.push('- Always specify `type` for each property');
  lines.push('- Mark essential fields as `required`');
  lines.push('- Use `enum` for fields with a fixed set of values');
  lines.push('- Add `description` to help readers understand each field');
  lines.push('- Use `items` to define array element types');
  lines.push('');
  lines.push('**Example usage:**');
  lines.push('```json');
  lines.push('{');
  lines.push('  "type": "object",');
  lines.push('  "properties": {');
  lines.push('    "name": { "type": "string", "description": "The person\'s name" },');
  lines.push('    "age": { "type": "number", "minimum": 0 },');
  lines.push('    "email": { "type": "string", "format": "email" }');
  lines.push('  },');
  lines.push('  "required": ["name", "email"]');
  lines.push('}');
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}
