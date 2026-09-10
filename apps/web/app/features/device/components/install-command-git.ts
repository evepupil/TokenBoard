export function createBashUpdateExistingRepoCommands(repoUrl: string, repoRef: string | null) {
  return [
    `git -C "$repo" remote set-url origin ${escapeBashArg(repoUrl)}`,
    ...createBashCheckoutRepoRefCommands(repoRef),
    ...(!repoRef ? ['git -C "$repo" pull --ff-only'] : [])
  ]
}

export function createBashCloneRepoCommands(repoUrl: string, repoRef: string | null) {
  if (!repoRef) return [`git clone ${escapeBashArg(repoUrl)} "$repo"`]
  return [
    `git clone --depth 1 --no-checkout ${escapeBashArg(repoUrl)} "$repo"`,
    ...createBashCheckoutRepoRefCommands(repoRef)
  ]
}

function createBashCheckoutRepoRefCommands(repoRef: string | null) {
  const ref = normalizeRepoRefForCommands(repoRef)
  if (!ref) return createBashEnsureDefaultBranchCommands()
  if (ref.kind === 'branch') return createBashCheckoutBranchCommands(ref.name)
  if (ref.kind === 'raw') return createBashCheckoutRawRefCommands(ref.name)
  return [
    `if git -C "$repo" fetch --depth 1 origin ${escapeBashArg(branchFetchRefspec(ref.name))}; then`,
    ...indent(createBashCheckoutFetchedBranchCommands(ref.name)),
    'else',
    ...indent(createBashCheckoutRawRefCommands(ref.name)),
    'fi'
  ]
}

function createBashEnsureDefaultBranchCommands() {
  return [
    'default_branch="$(git -C "$repo" ls-remote --symref origin HEAD | sed -n \'s#^ref: refs/heads/\\([^[:space:]]*\\)[[:space:]]HEAD$#\\1#p\' | head -n 1)"',
    'test -n "$default_branch"',
    'git -C "$repo" config --replace-all remote.origin.fetch \'+refs/heads/*:refs/remotes/origin/*\'',
    'git -C "$repo" fetch origin "+refs/heads/$default_branch:refs/remotes/origin/$default_branch"',
    'git -C "$repo" remote set-head origin --auto',
    'if git -C "$repo" show-ref --verify --quiet "refs/heads/$default_branch"; then',
    '  git -C "$repo" checkout "$default_branch"',
    'else',
    '  git -C "$repo" checkout -B "$default_branch" "refs/remotes/origin/$default_branch"',
    'fi',
    'git -C "$repo" config "branch.$default_branch.remote" origin',
    'git -C "$repo" config "branch.$default_branch.merge" "refs/heads/$default_branch"'
  ]
}

function createBashCheckoutBranchCommands(branchName: string) {
  return [
    `git -C "$repo" fetch --depth 1 origin ${escapeBashArg(branchFetchRefspec(branchName))}`,
    ...createBashCheckoutFetchedBranchCommands(branchName)
  ]
}

function createBashCheckoutFetchedBranchCommands(branchName: string) {
  return [
    `git -C "$repo" checkout -B ${escapeBashArg(branchName)} ${escapeBashArg(remoteBranchRef(branchName))}`,
    `git -C "$repo" config ${escapeBashArg(`branch.${branchName}.remote`)} origin`,
    `git -C "$repo" config ${escapeBashArg(`branch.${branchName}.merge`)} ${escapeBashArg(`refs/heads/${branchName}`)}`
  ]
}

function createBashCheckoutRawRefCommands(refName: string) {
  return [`git -C "$repo" fetch --depth 1 origin ${escapeBashArg(refName)}`, 'git -C "$repo" checkout FETCH_HEAD']
}

export function createPowerShellUpdateExistingRepoCommands(repoUrl: string, repoRef: string | null) {
  return [
    `Invoke-Git -C $repo remote set-url origin ${escapePowerShellArg(repoUrl)}`,
    ...createPowerShellCheckoutRepoRefCommands(repoRef),
    ...(!repoRef ? ['Invoke-Git -C $repo pull --ff-only'] : [])
  ]
}

export function createPowerShellCloneRepoCommands(repoUrl: string, repoRef: string | null) {
  if (!repoRef) return [`Invoke-Git clone ${escapePowerShellArg(repoUrl)} $repo`]
  return [
    `Invoke-Git clone --depth 1 --no-checkout ${escapePowerShellArg(repoUrl)} $repo`,
    ...createPowerShellCheckoutRepoRefCommands(repoRef)
  ]
}

function createPowerShellCheckoutRepoRefCommands(repoRef: string | null) {
  const ref = normalizeRepoRefForCommands(repoRef)
  if (!ref) return createPowerShellEnsureDefaultBranchCommands()
  if (ref.kind === 'branch') return createPowerShellCheckoutBranchCommands(ref.name)
  if (ref.kind === 'raw') return createPowerShellCheckoutRawRefCommands(ref.name)
  return [
    `git -C $repo fetch --depth 1 origin ${escapePowerShellArg(branchFetchRefspec(ref.name))}`,
    'if ($LASTEXITCODE -eq 0) {',
    ...indent(createPowerShellCheckoutFetchedBranchCommands(ref.name)),
    '} else {',
    ...indent(createPowerShellCheckoutRawRefCommands(ref.name)),
    '}'
  ]
}

function createPowerShellEnsureDefaultBranchCommands() {
  return [
    '$defaultBranchLine = git -C $repo ls-remote --symref origin HEAD | Where-Object { $_ -match "^ref: refs/heads/.+\\sHEAD$" } | Select-Object -First 1',
    'if (-not $defaultBranchLine) { throw "Unable to resolve origin default branch" }',
    '$defaultBranch = $defaultBranchLine -replace "^ref: refs/heads/([^\\s]+)\\sHEAD$", \'$1\'',
    'Invoke-Git -C $repo config --replace-all remote.origin.fetch "+refs/heads/*:refs/remotes/origin/*"',
    'Invoke-Git -C $repo fetch origin "+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}"',
    'Invoke-Git -C $repo remote set-head origin --auto',
    'git -C $repo show-ref --verify --quiet "refs/heads/$defaultBranch"',
    'if ($LASTEXITCODE -eq 0) {',
    '  Invoke-Git -C $repo checkout $defaultBranch',
    '} else {',
    '  Invoke-Git -C $repo checkout -B $defaultBranch "refs/remotes/origin/$defaultBranch"',
    '}',
    'Invoke-Git -C $repo config "branch.$defaultBranch.remote" origin',
    'Invoke-Git -C $repo config "branch.$defaultBranch.merge" "refs/heads/$defaultBranch"'
  ]
}

function createPowerShellCheckoutBranchCommands(branchName: string) {
  return [
    `Invoke-Git -C $repo fetch --depth 1 origin ${escapePowerShellArg(branchFetchRefspec(branchName))}`,
    ...createPowerShellCheckoutFetchedBranchCommands(branchName)
  ]
}

function createPowerShellCheckoutFetchedBranchCommands(branchName: string) {
  return [
    `Invoke-Git -C $repo checkout -B ${escapePowerShellArg(branchName)} ${escapePowerShellArg(remoteBranchRef(branchName))}`,
    `Invoke-Git -C $repo config ${escapePowerShellArg(`branch.${branchName}.remote`)} origin`,
    `Invoke-Git -C $repo config ${escapePowerShellArg(`branch.${branchName}.merge`)} ${escapePowerShellArg(`refs/heads/${branchName}`)}`
  ]
}

function createPowerShellCheckoutRawRefCommands(refName: string) {
  return [
    `Invoke-Git -C $repo fetch --depth 1 origin ${escapePowerShellArg(refName)}`,
    'Invoke-Git -C $repo checkout FETCH_HEAD'
  ]
}

function normalizeRepoRefForCommands(repoRef: string | null) {
  if (!repoRef) return null
  if (repoRef.startsWith('refs/heads/')) return { kind: 'branch' as const, name: repoRef.slice(11) }
  if (repoRef.startsWith('refs/')) return { kind: 'raw' as const, name: repoRef }
  return { kind: 'branch-or-ref' as const, name: repoRef }
}

function branchFetchRefspec(name: string) {
  return `+refs/heads/${name}:refs/remotes/origin/${name}`
}
function remoteBranchRef(name: string) {
  return `refs/remotes/origin/${name}`
}
export function indent(lines: string[]) {
  return lines.map((line) => `  ${line}`)
}
export function escapeBashArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}
export function escapePowerShellArg(value: string) {
  return `"${value.replaceAll('`', '``').replaceAll('"', '`"').replaceAll('$', '`$')}"`
}
