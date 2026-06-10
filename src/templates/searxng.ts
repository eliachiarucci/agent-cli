export function searxngSettings(secretKey: string): string {
  return `use_default_settings: true

server:
  secret_key: "${secretKey}"
  # Internal instance, only reachable from the app — bot protection would
  # block the JSON API requests the agent's search tool makes.
  limiter: false

search:
  formats:
    - html
    - json
`;
}
