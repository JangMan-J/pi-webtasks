/**
 * The one source-policy rule for every tool that takes one: web_search,
 * web_answer, and web_research.
 *
 *  - Domains are trimmed, blanks dropped, and each must be a bare domain
 *    (`example.com`, `*.example.com`), never a URL.
 *  - include_domains and exclude_domains together take at most 200 entries.
 *  - after_date, where a tool takes one, is a real calendar date, YYYY-MM-DD.
 *
 * Every violation is thrown before a run is recorded or a request is paid for.
 * Each tool maps the normalized policy onto its own request body.
 */

export type SourcePolicyInput = {
  include_domains?: string[];
  exclude_domains?: string[];
  after_date?: string;
};

export type SourcePolicy = {
  include: string[];
  exclude: string[];
  afterDate?: string;
};

const MAX_DOMAINS = 200;
const BARE_DOMAIN = /^[a-z0-9.*-]+$/i;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function domains(list: string[] | undefined): string[] {
  const cleaned = (list ?? []).map(domain => domain.trim()).filter(Boolean);
  for (const domain of cleaned) {
    if (!BARE_DOMAIN.test(domain)) throw new Error(`"${domain}" is not a bare domain (write example.com, not a URL)`);
  }
  return cleaned;
}

/** Validate and normalize a source policy. */
export function sourcePolicy(input: SourcePolicyInput): SourcePolicy {
  const include = domains(input.include_domains);
  const exclude = domains(input.exclude_domains);
  if (include.length + exclude.length > MAX_DOMAINS) {
    throw new Error(`include_domains and exclude_domains together take at most ${MAX_DOMAINS} entries`);
  }
  const afterDate = input.after_date?.trim() || undefined;
  if (afterDate !== undefined && (!CALENDAR_DATE.test(afterDate) || Number.isNaN(Date.parse(afterDate)))) {
    throw new Error("after_date must be a calendar date in YYYY-MM-DD form");
  }
  return { include, exclude, ...(afterDate ? { afterDate } : {}) };
}

/** The policy in Parallel's Search and Task `source_policy` shape, or undefined when it restricts nothing. */
export function providerSourcePolicy(policy: SourcePolicy): { include_domains?: string[]; exclude_domains?: string[]; after_date?: string } | undefined {
  if (!policy.include.length && !policy.exclude.length && !policy.afterDate) return undefined;
  return {
    ...(policy.afterDate ? { after_date: policy.afterDate } : {}),
    ...(policy.include.length ? { include_domains: policy.include } : {}),
    ...(policy.exclude.length ? { exclude_domains: policy.exclude } : {}),
  };
}
