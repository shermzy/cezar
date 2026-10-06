import { bootstrapOwner, repairOwner, resetPassword } from './auth.ts';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

async function readPassword(prompts: typeof import('@clack/prompts'), message: string): Promise<string | null> {
  const answer = await prompts.password({
    message,
    validate: (value) => value.length >= 12 && value.length <= 1024 ? undefined : 'Use 12 to 1024 characters.',
  });
  return prompts.isCancel(answer) ? null : answer;
}

export async function runAuthCommand(args: string[]): Promise<number> {
  const [action, usernameArg] = args;
  if (!['bootstrap', 'repair', 'reset-password'].includes(action ?? '')) {
    console.error('Usage: cezar auth <bootstrap|repair|reset-password [username]>');
    return 2;
  }
  if (process.env.CEZ_AUTH_REQUIRED !== '1') {
    console.error('Managed access is not enabled in this process. Persist CEZ_AUTH_REQUIRED=1 in the Cezar service launcher, restart the service, then run this command locally with CEZ_AUTH_REQUIRED=1 in your shell.');
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('This command requires an interactive local terminal so passwords are not passed in arguments or environment variables.');
    return 1;
  }

  const prompts = await import('@clack/prompts');
  let username = usernameArg?.trim().toLowerCase();
  if (action !== 'reset-password' || !username) {
    const answer = await prompts.text({
      message: 'Owner username',
      placeholder: 'workspace-owner',
      validate: (value) => USERNAME_RE.test(value.trim().toLowerCase()) ? undefined : 'Use 2–32 lowercase letters, numbers, dots, dashes, or underscores.',
    });
    if (prompts.isCancel(answer)) return 1;
    username = answer.trim().toLowerCase();
  }
  const password = await readPassword(prompts, action === 'reset-password' ? `New password for ${username}` : 'Owner password (12 characters minimum)');
  if (password === null) return 1;
  const confirm = await readPassword(prompts, 'Confirm password');
  if (confirm === null) return 1;
  if (password !== confirm) {
    console.error('Passwords do not match.');
    return 1;
  }

  if (action === 'repair') {
    const acknowledgement = await prompts.text({ message: 'Type REPAIR to back up the damaged auth store and replace it with this owner account.' });
    if (prompts.isCancel(acknowledgement) || acknowledgement !== 'REPAIR') return 1;
  }

  try {
    if (action === 'bootstrap') {
      await bootstrapOwner(username, password);
      console.log(`Owner login created for ${username}.`);
    } else if (action === 'repair') {
      const backupPath = await repairOwner(username, password);
      console.log(`Managed access repaired. The damaged store was preserved at ${backupPath}.`);
    } else {
      const changed = await resetPassword(username, password);
      if (!changed) {
        console.error(`No account found for ${username}.`);
        return 1;
      }
      console.log(`Password reset for ${username}; all of that account's sessions were revoked.`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Managed access could not be updated.');
    return 1;
  }
}
