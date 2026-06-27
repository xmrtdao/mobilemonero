import { useState } from 'react'
import { AGENTS } from '../../lib/mockData'

interface Props {
  onOpenChat: (agentId: string) => void
}

export default function AgentsSection({ onOpenChat }: Props) {
  const govAgents = AGENTS.filter(a => a.type === 'governance')
  const invAgents = AGENTS.filter(a => a.type === 'investor')
  const sysAgents = AGENTS.filter(a => a.type === 'system')

  return (
    <section id="agents" className="px-8 py-20">
      <div className="max-w-[1200px] mx-auto">
        <div className="reveal">
          <p className="section-label">AI-Native Operations</p>
          <h2 className="section-title">
            Agent<br />
            <em>Directory</em>
          </h2>
          <p className="text-[11px] tracking-[0.08em] text-[rgba(255,160,0,0.55)] max-w-[560px] leading-[2] mt-4 mb-10">
            Constitutional AI agents govern the campus. Each operates within 
            bounded constraints defined in SOUL.md and CONSTITUTION.md. 
            TrustGraph scores all actions.
          </p>
        </div>

        {/* Governance Agents */}
        <div className="mb-12">
          <h3 className="text-[9px] tracking-[0.18em] text-[rgba(255,160,0,0.4)] uppercase mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--green)]" />
            Governance Agents
          </h3>
          <div className="agents-grid grid grid-cols-1 md:grid-cols-2 gap-4">
            {govAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onChat={onOpenChat} />
            ))}
          </div>
        </div>

        {/* Investor Agents */}
        <div className="mb-12">
          <h3 className="text-[9px] tracking-[0.18em] text-[rgba(255,160,0,0.4)] uppercase mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--amber)]" />
            Investor Agents
          </h3>
          <div className="agents-grid grid grid-cols-1 md:grid-cols-2 gap-4">
            {invAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onChat={onOpenChat} />
            ))}
          </div>
        </div>

        {/* System Agents */}
        <div>
          <h3 className="text-[9px] tracking-[0.18em] text-[rgba(255,160,0,0.4)] uppercase mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--purple)]" />
            System Contracts
          </h3>
          <div className="agents-grid grid grid-cols-1 md:grid-cols-2 gap-4">
            {sysAgents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} onChat={onOpenChat} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

interface AgentCardProps {
  agent: typeof AGENTS[number]
  onChat: (id: string) => void
}

const FILE_TYPE_COLORS: Record<string, string> = {
  md: '#ffaa00',
  json: '#00ffcc',
  py: '#6274ea',
  ts: '#9945ff',
}

function AgentCard({ agent, onChat }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="reveal border border-[var(--border)] bg-[rgba(255,140,0,0.02)] hover:border-[var(--amber2)] transition-all" data-testid="agent-card" data-agent-id={agent.id}>
      {/* Main card header — always visible */}
      <div className="p-5">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-[14px] font-bold"
              style={{
                background: `${agent.color}18`,
                border: `1px solid ${agent.color}44`,
                color: agent.color,
              }}
            >
              {agent.name[0]}
            </div>
            <div>
              <h4 className="font-display text-[16px] font-semibold text-white">
                {agent.name}
              </h4>
              <div className="text-[9px] tracking-[0.1em] text-[rgba(255,160,0,0.5)]">
                {agent.role}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                agent.status === 'online' ? 'bg-[var(--green)]' :
                agent.status === 'standby' ? 'bg-[var(--amber)]' : 'bg-[var(--purple)]'
              } animate-[pulse-dot_2s_ease-in-out_infinite]`}
            />
            <span className="text-[8px] tracking-[0.1em] uppercase text-[rgba(255,160,0,0.4)]">
              {agent.status}
            </span>
          </div>
        </div>

        <p className="text-[10px] tracking-[0.04em] text-[rgba(255,160,0,0.55)] leading-[1.8] mb-4">
          {agent.description}
        </p>

        {agent.trustScore && (
          <div className="flex items-center gap-2 mb-4">
            <div className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.4)] uppercase">Trust</div>
            <div className="flex-1 h-1 bg-[rgba(255,140,0,0.1)] rounded overflow-hidden">
              <div className="h-full bg-[var(--green)]" style={{ width: `${agent.trustScore}%` }} />
            </div>
            <div className="text-[10px] tracking-[0.05em] text-[var(--green)]">{agent.trustScore}</div>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 mb-4">
          {agent.files.slice(0, 3).map((file, i) => (
            <span
              key={i}
              className="px-2 py-0.5 text-[8px] tracking-[0.08em] border border-[var(--border)] text-[rgba(255,160,0,0.5)]"
            >
              {file.name}
            </span>
          ))}
          {agent.files.length > 3 && !expanded && (
            <span className="text-[8px] tracking-[0.08em] text-[rgba(255,160,0,0.3)]">
              +{agent.files.length - 3} more
            </span>
          )}
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-[var(--border)]">
          <span className="text-[8px] tracking-[0.1em] text-[rgba(255,160,0,0.35)]">{agent.version}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setExpanded(e => !e)}
              className="px-3 py-1 text-[8px] tracking-[0.1em] uppercase border border-[var(--border)] text-[rgba(255,160,0,0.5)] bg-transparent hover:bg-[rgba(255,140,0,0.06)] transition-all cursor-pointer font-mono"
            >
              {expanded ? 'Less ▲' : 'Details ▼'}
            </button>
            <button
              onClick={() => onChat(agent.id)}
              data-testid="agent-chat-btn"
              className="px-3 py-1 text-[8px] tracking-[0.1em] uppercase border border-[var(--amber2)] text-[var(--amber)] bg-[rgba(255,140,0,0.08)] hover:bg-[rgba(255,140,0,0.18)] transition-all cursor-pointer font-mono"
            >
              Chat &rarr;
            </button>
          </div>
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div
          className="border-t border-[var(--border)] px-5 py-4 flex flex-col gap-4"
          style={{ background: `${agent.color}06` }}
        >
          {/* All files */}
          <div>
            <div className="text-[8px] tracking-[0.14em] uppercase mb-2" style={{ color: 'rgba(255,160,0,0.4)' }}>
              Active Files — {agent.files.length} total
            </div>
            <div className="flex flex-col gap-1">
              {agent.files.map((file, i) => (
                <div key={i} className="flex items-center justify-between py-1"
                  style={{ borderBottom: i < agent.files.length - 1 ? '0.5px solid rgba(255,140,0,0.08)' : 'none' }}>
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[7px] tracking-[0.08em] uppercase px-1.5 py-0.5 font-mono"
                      style={{
                        color: FILE_TYPE_COLORS[file.type] || 'rgba(255,160,0,0.5)',
                        border: `0.5px solid ${FILE_TYPE_COLORS[file.type] || 'rgba(255,160,0,0.3)'}44`,
                      }}
                    >
                      {file.type}
                    </span>
                    <span className="text-[9px] tracking-[0.04em] text-[rgba(255,160,0,0.7)]">{file.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[7px] text-[rgba(255,160,0,0.3)]">{file.size}</span>
                    <span
                      className="text-[7px] tracking-[0.08em] uppercase"
                      style={{ color: file.status === 'live' ? 'var(--green)' : 'rgba(255,160,0,0.45)' }}
                    >
                      {file.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Constitutional voice */}
          <div>
            <div className="text-[8px] tracking-[0.14em] uppercase mb-2" style={{ color: 'rgba(255,160,0,0.4)' }}>
              Constitutional Voice
            </div>
            <div
              className="p-3 text-[9px] leading-[1.8] tracking-[0.04em] italic"
              style={{
                background: 'rgba(255,140,0,0.04)',
                border: '0.5px solid rgba(255,140,0,0.14)',
                color: 'rgba(255,160,0,0.65)',
              }}
            >
              "{agent.greeting}"
            </div>
          </div>

          {/* Sample output */}
          {agent.responses && agent.responses.length > 0 && (
            <div>
              <div className="text-[8px] tracking-[0.14em] uppercase mb-2" style={{ color: 'rgba(255,160,0,0.4)' }}>
                Example Output
              </div>
              <div
                className="p-3 text-[9px] leading-[1.8] tracking-[0.04em]"
                style={{
                  background: `${agent.color}08`,
                  border: `0.5px solid ${agent.color}22`,
                  color: 'rgba(255,160,0,0.6)',
                  borderLeft: `2px solid ${agent.color}66`,
                }}
              >
                {agent.responses[0]}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
