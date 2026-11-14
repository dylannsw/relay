import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconAlertCircle, IconArrowLeft, IconBrandTelegram, IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, errorText } from "@/api";
import { quick } from "@/lib/motion";
import { setStatus } from "@/telegram/store";
import type { TgStatus } from "@/telegram/types";

const STEPS = ["keys", "phone", "code"] as const;

/**
 * Signing in to Telegram, one step at a time: the API ID and hash from my.telegram.org (once),
 * your phone number, the code Telegram sends to your Telegram app, and your cloud password if
 * the account has two-step verification.
 */
export function TelegramSetup({ status }: { status: TgStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (step: () => Promise<TgStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await step());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const stage = status.stage;
  const stepIndex = stage === "password" ? 2 : STEPS.indexOf(stage as (typeof STEPS)[number]);

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#2aabee] text-white">
            <IconBrandTelegram className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">Connect Telegram</h1>
            {stepIndex >= 0 && (
              <p className="text-sm text-muted-foreground tabular-nums">
                Step {stepIndex + 1} of {STEPS.length}
              </p>
            )}
          </div>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={stage}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={quick}
          >
            {stage === "keys" && <KeysStep busy={busy} error={error} onSubmit={(id, hash) => run(() => api.telegram.setKeys(id, hash))} />}
            {stage === "phone" && <PhoneStep busy={busy} error={error} onSubmit={(phone) => run(() => api.telegram.sendCode(phone))} />}
            {stage === "code" && (
              <CodeStep
                phone={status.phone}
                busy={busy}
                error={error}
                onSubmit={(code) => run(() => api.telegram.signIn(code))}
                onBack={() => run(() => api.telegram.restartLogin())}
              />
            )}
            {stage === "password" && (
              <PasswordStep
                hint={status.passwordHint}
                busy={busy}
                error={error}
                onSubmit={(pw) => run(() => api.telegram.checkPassword(pw))}
                onBack={() => run(() => api.telegram.restartLogin())}
              />
            )}
            {stage === "offline" && <OfflineStep error={status.error} busy={busy} onRetry={() => run(() => api.telegram.reconnect())} />}
          </motion.div>
        </AnimatePresence>

        <p className="mt-8 text-xs leading-relaxed text-muted-foreground">
          Relay signs in as you, the way Telegram Desktop does, and keeps the session encrypted on this PC. It shows up in
          Telegram under Settings → Devices, where you can end it any time.
        </p>
      </div>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
      <IconAlertCircle className="mt-0.5 size-4 shrink-0" />
      {error}
    </p>
  );
}

function StepForm(props: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      {props.children}
    </form>
  );
}

function Submit({ busy, disabled, children, busyText }: { busy: boolean; disabled?: boolean; children: ReactNode; busyText: string }) {
  return (
    <Button type="submit" disabled={busy || disabled} className="self-start">
      {busy && <Spinner />}
      {busy ? busyText : children}
    </Button>
  );
}

function KeysStep({ busy, error, onSubmit }: { busy: boolean; error: string | null; onSubmit: (id: string, hash: string) => void }) {
  const [id, setId] = useState("");
  const [hash, setHash] = useState("");
  return (
    <StepForm onSubmit={() => onSubmit(id, hash)}>
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Telegram asks apps you build yourself to use their own API ID. It's free and takes a minute, and you only do it
          once:
        </p>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-muted-foreground marker:text-muted-foreground">
          <li>
            Open{" "}
            <button type="button" className="font-medium text-foreground underline underline-offset-4 hover:text-primary" onClick={() => void api.openExternal("https://my.telegram.org/apps")}>
              my.telegram.org
              <IconExternalLink className="ml-0.5 inline size-3.5 -translate-y-px" />
            </button>{" "}
            and log in with your phone number.
          </li>
          <li>
            Choose <span className="font-medium text-foreground">API development tools</span> and fill in the form. Any
            title works (say, “Relay”); pick <span className="font-medium text-foreground">Desktop</span> as the platform.
          </li>
          <li>
            Copy <span className="font-medium text-foreground">App api_id</span> and{" "}
            <span className="font-medium text-foreground">App api_hash</span> into the fields below.
          </li>
        </ol>
      </div>
      <FieldGroup>
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor="tg-api-id">API ID</FieldLabel>
          <Input id="tg-api-id" autoFocus inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="1234567" value={id} onChange={(e) => setId(e.target.value)} className="font-mono" />
        </Field>
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor="tg-api-hash">API hash</FieldLabel>
          <Input id="tg-api-hash" autoComplete="off" spellCheck={false} placeholder="32 letters and digits" value={hash} onChange={(e) => setHash(e.target.value)} className="font-mono" />
          <FieldDescription>Kept encrypted on this PC. Don't share these: they identify your app to Telegram.</FieldDescription>
        </Field>
      </FieldGroup>
      <ErrorLine error={error} />
      <Submit busy={busy} disabled={!id.trim() || !hash.trim()} busyText="Connecting…">
        Continue
      </Submit>
    </StepForm>
  );
}

function PhoneStep({ busy, error, onSubmit }: { busy: boolean; error: string | null; onSubmit: (phone: string) => void }) {
  const [phone, setPhone] = useState("+");
  return (
    <StepForm onSubmit={() => onSubmit(phone)}>
      <FieldGroup>
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor="tg-phone">Phone number</FieldLabel>
          <Input id="tg-phone" autoFocus type="tel" autoComplete="tel" placeholder="+ country code and number" value={phone} onChange={(e) => setPhone(e.target.value)} className="tabular-nums" />
          <FieldDescription>The number your Telegram account uses. Telegram sends a login code to your Telegram app.</FieldDescription>
        </Field>
      </FieldGroup>
      <ErrorLine error={error} />
      <Submit busy={busy} disabled={phone.replace(/\D/g, "").length < 7} busyText="Sending code…">
        Send code
      </Submit>
    </StepForm>
  );
}

function BackButton({ onBack, disabled, children }: { onBack: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="-ml-2 self-start pl-1.5 text-muted-foreground" disabled={disabled} onClick={onBack}>
      <IconArrowLeft />
      {children}
    </Button>
  );
}

function CodeStep(props: { phone: string | null; busy: boolean; error: string | null; onSubmit: (code: string) => void; onBack: () => void }) {
  const [code, setCode] = useState("");
  const digits = code.replace(/\D/g, "");
  return (
    <StepForm onSubmit={() => props.onSubmit(digits)}>
      <BackButton onBack={props.onBack} disabled={props.busy}>
        Use a different number
      </BackButton>
      <FieldGroup>
        <Field data-invalid={!!props.error || undefined}>
          <FieldLabel htmlFor="tg-code">Login code</FieldLabel>
          <Input
            id="tg-code"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            placeholder="12345"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-40 font-mono text-lg tracking-[0.3em] tabular-nums"
          />
          <FieldDescription>
            Telegram sent it {props.phone ? <>for <span className="font-medium text-foreground tabular-nums">{props.phone}</span> </> : null}
            to your Telegram app, as a message from “Telegram”. It's not an SMS unless the app isn't installed.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <ErrorLine error={props.error} />
      <Submit busy={props.busy} disabled={digits.length < 5} busyText="Signing in…">
        Sign in
      </Submit>
    </StepForm>
  );
}

function PasswordStep(props: { hint: string | null; busy: boolean; error: string | null; onSubmit: (pw: string) => void; onBack: () => void }) {
  const [pw, setPw] = useState("");
  return (
    <StepForm onSubmit={() => props.onSubmit(pw)}>
      <BackButton onBack={props.onBack} disabled={props.busy}>
        Start over
      </BackButton>
      <FieldGroup>
        <Field data-invalid={!!props.error || undefined}>
          <FieldLabel htmlFor="tg-password">Cloud password</FieldLabel>
          <Input id="tg-password" autoFocus type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <FieldDescription>
            Your account has two-step verification. Relay sends the password to Telegram to finish signing in and doesn't
            keep it.{props.hint && <> Hint: <span className="font-medium text-foreground">{props.hint}</span></>}
          </FieldDescription>
        </Field>
      </FieldGroup>
      <ErrorLine error={props.error} />
      <Submit busy={props.busy} disabled={!pw} busyText="Signing in…">
        Sign in
      </Submit>
    </StepForm>
  );
}

function OfflineStep({ error, busy, onRetry }: { error: string | null; busy: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <ErrorLine error={error ?? "Couldn't reach Telegram."} />
      <Button variant="outline" className="self-start" disabled={busy} onClick={onRetry}>
        {busy ? <Spinner /> : <IconRefresh />}
        {busy ? "Connecting…" : "Try again"}
      </Button>
    </div>
  );
}
