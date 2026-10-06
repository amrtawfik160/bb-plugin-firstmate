# Plugin installation

A user installs Firstmate, finds its entry skills, and sees that its default methods follow native policy.

## Sub-features

- `package-install` loads this candidate on a private BB server.
- `package-doctor` confirms the exact installed build, host, and bundled release.
- `package-skills` discovers only the shipped captain and firstmate entries.
- `package-defaults` reports the unconfigured methods profile as off.

## How to get to it (user POV)

Run `bb plugin install . --yes`, `bb plugin list`, `bb skill list`, and `bb firstmate methods status`.

## Driving it with verify-firstmate

Preconditions: build the candidate and allocate a fresh evidence directory as shown in the skill.

1. Run the helper with `--feature package --evidence "$FIRSTMATE_VERIFY_EVIDENCE"`.
2. Require the doctor to pass and public skill discovery to return exactly the two shipped entries.
3. Require methods status to report `off` on the private installation.
4. Read `commands.json`, `doctor.json`, and `result.json`. Require successful exits and the expected build identity.
5. Require cleanup to stop both services and preserve the evidence.

## Gotchas

The production methods profile may be selected-v1. The new private installation deliberately tests native defaults. It does not change production settings or start a captain session.
