import { RemoveButton, TextAreaField, TextField, fieldClass } from './fields';
import { CHECK_TYPES, checkProblem, type Check } from '../lib/data';

const selectClass = `${fieldClass} font-mono`;
const HINTS: Record<string, string> = {
  must_call: 'Each row must be called. A row with several tools passes if any one of them is called.',
  must_not_call: 'None of these tools may be called.',
  max_tool_calls: 'At most this many tool calls in total, or of one tool.',
  max_tool_rounds: 'At most this many rounds of tool calls (a round is one model turn that calls tools).',
  must_call_before: 'The first tool must be called before the second.',
  must_call_with_values: 'The tool must be called with arguments that include these values.',
  max_prompt_tokens: 'No single model call may have a prompt longer than this.',
  max_model_calls: 'At most this many model calls in total.',
  custom: "Any fields; handled by the agent's hook.",
};

function ToolSelect({ value, tools, onChange, label }: { value: string; tools: string[]; onChange: (tool: string) => void; label: string }) {
  return (
    <select className={selectClass} aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
      <option value="">{tools.length ? 'Pick a tool' : 'Loading tools…'}</option>
      {value && !tools.includes(value) ? <option value={value}>{value}</option> : null}
      {tools.map((tool) => <option key={tool} value={tool}>{tool}</option>)}
    </select>
  );
}

// Tool names as rows. In "any of" mode a row holds several tools (shown as chips) and passes if one is called.
function ToolGroups({ groups, tools, anyOf, onChange }: { groups: string[][]; tools: string[]; anyOf: boolean; onChange: (groups: string[][]) => void }) {
  const setGroup = (index: number, group: string[]) => onChange(groups.map((g, i) => (i === index ? group : g)));
  return (
    <div className="flex flex-col gap-space-1">
      {groups.map((group, index) => (
        <div key={index} className="flex flex-wrap items-center gap-space-1">
          {group.map((tool, at) => (
            <span key={at} className="inline-flex items-center gap-space-1">
              {at > 0 ? <span className="text-xs text-tertiary">or</span> : null}
              <span className="w-56"><ToolSelect label="Tool" value={tool} tools={tools} onChange={(next) => setGroup(index, group.map((t, i) => (i === at ? next : t)))} /></span>
              {group.length > 1 ? <RemoveButton label="Remove tool from this row" onClick={() => setGroup(index, group.filter((_, i) => i !== at))} /> : null}
            </span>
          ))}
          {anyOf ? (
            <button type="button" className="text-xs text-secondary underline hover:text-primary" onClick={() => setGroup(index, [...group, ''])}>or another</button>
          ) : null}
          <RemoveButton label="Remove row" onClick={() => onChange(groups.filter((_, i) => i !== index))} />
        </div>
      ))}
      <div>
        <button type="button" className="text-xs text-secondary underline hover:text-primary" onClick={() => onChange([...groups, ['']])}>Add tool</button>
      </div>
    </div>
  );
}

// One code check: a name (its feedback key), a type, and that type's params.
export function CheckEditor({ check, tools, onChange, onRemove }: { check: Check; tools: string[]; onChange: (patch: Partial<Check>) => void; onRemove: () => void }) {
  const problem = checkProblem(check);
  const max = <TextField label="Max" value={check.max} onChange={(value) => onChange({ max: value })} placeholder="3" mono />;
  return (
    <div className="flex flex-col gap-space-2 rounded-md border border-default bg-surface-level-1 p-space-3">
      <div className="flex items-center gap-space-2">
        <div className="w-64"><TextField value={check.name} onChange={(name) => onChange({ name: name.toLowerCase().replace(/[\s_]+/g, '-') })} placeholder="check-name" mono /></div>
        <select className={`${selectClass} w-56`} aria-label="Check type" value={check.type}
          // Params belong to a type, so switching drops the old type's JSON; the name stays.
          onChange={(event) => onChange({ type: event.currentTarget.value, extra: {}, json: '' })}>
          {CHECK_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          {!(CHECK_TYPES as readonly string[]).includes(check.type) ? <option value={check.type}>{check.type}</option> : null}
        </select>
        <div className="flex-1" />
        <RemoveButton label={`Remove check ${check.name}`} onClick={onRemove} />
      </div>
      <span className="text-xs text-tertiary">{HINTS[check.type] ?? HINTS.custom}</span>
      {check.type === 'must_call' || check.type === 'must_not_call' ? (
        <ToolGroups groups={check.groups} tools={tools} anyOf={check.type === 'must_call'} onChange={(groups) => onChange({ groups })} />
      ) : null}
      {check.type === 'max_tool_calls' ? (
        <div className="grid grid-cols-[120px_minmax(0,1fr)] items-end gap-space-3">
          {max}
          <label className="flex flex-col gap-space-1 text-sm font-medium text-secondary">Tool (optional; empty counts all tools)
            <ToolSelect label="Tool" value={check.tool} tools={tools} onChange={(tool) => onChange({ tool })} />
          </label>
        </div>
      ) : null}
      {['max_tool_rounds', 'max_prompt_tokens', 'max_model_calls'].includes(check.type) ? <div className="w-32">{max}</div> : null}
      {check.type === 'must_call_before' ? (
        <div className="grid grid-cols-2 gap-space-3">
          <label className="flex flex-col gap-space-1 text-sm font-medium text-secondary">First<ToolSelect label="First tool" value={check.first} tools={tools} onChange={(first) => onChange({ first })} /></label>
          <label className="flex flex-col gap-space-1 text-sm font-medium text-secondary">Second<ToolSelect label="Second tool" value={check.second} tools={tools} onChange={(second) => onChange({ second })} /></label>
        </div>
      ) : null}
      {check.type === 'must_call_with_values' ? (
        <div className="flex flex-col gap-space-2">
          <label className="flex flex-col gap-space-1 text-sm font-medium text-secondary">Tool<ToolSelect label="Tool" value={check.tool} tools={tools} onChange={(tool) => onChange({ tool })} /></label>
          <TextAreaField label="Args (JSON object)" value={check.json} onChange={(json) => onChange({ json })} rows={3} mono placeholder='{"order_id": "A1001"}' />
        </div>
      ) : null}
      {!(check.type in HINTS) || check.type === 'custom' ? (
        <TextAreaField label="Fields (JSON object, without name and type)" value={check.json} onChange={(json) => onChange({ json })} rows={4} mono placeholder='{"threshold": 3}' />
      ) : null}
      {problem && check.name ? <span className="text-xs text-error-primary">{problem}</span> : null}
    </div>
  );
}
