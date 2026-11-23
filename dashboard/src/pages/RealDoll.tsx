import { ControlPanel } from "../components/ControlPanel";
import { DevicePanel, type DevicePanelProps } from "../components/DevicePanel";
import { InfoTip } from "../components/InfoTip";
import { RemoteActions } from "../components/RemoteActions";
import { TalkPanel } from "../components/TalkPanel";
import { COPY } from "../content/copy";
import { DEVICE_ID } from "../hooks/useDeviceStatus";
import type { ApiClient, VoiceInfo } from "../lib/api";
import { capabilities, type Role } from "../lib/roles";

export interface RealDollPageProps {
  api: ApiClient;
  role: Role;
  online: boolean;
  cloudAvailable: boolean;
  voice: VoiceInfo | null;
  deviceResponse: DevicePanelProps["response"];
  /** Called after a command reached the cloud, so the status is asked for again soon. */
  onCommandSent?: () => void;
}

/**
 * Control room of the real doll (the Raspberry Pi in the house), separate from the web
 * simulation. A guest sees one sign-in note instead of a row of locked buttons.
 */
export function RealDollPage({
  api,
  role,
  online,
  cloudAvailable,
  voice,
  deviceResponse,
  onCommandSent,
}: RealDollPageProps) {
  const caps = capabilities(role);
  return (
    <main className="page real-doll" aria-labelledby="real-doll-heading">
      <h1 id="real-doll-heading" className="page-title">
        {COPY.shell.realDollHeading}
        <InfoTip text={COPY.tips.realDoll} />
      </h1>
      <p className="house__intro">{COPY.realDollPage.intro}</p>
      {role === "visitor" ? (
        <p className="real-doll__locked" role="status">
          {COPY.realDollPage.signInNeeded}
        </p>
      ) : (
        <>
          {!caps.controls && <p role="status">{COPY.realDollPage.needFamily}</p>}
          <fieldset className="real-doll__group" disabled={!online}>
            <DevicePanel role={role} response={deviceResponse} />
            <ControlPanel
              api={api}
              role={role}
              deviceId={DEVICE_ID}
              dollState={deviceResponse?.status?.state ?? null}
              onSent={onCommandSent}
            />
          </fieldset>
          {caps.controls && <RemoteActions api={api} deviceId={DEVICE_ID} />}
          {cloudAvailable && (
            <TalkPanel api={api} role={role} deviceId={DEVICE_ID} voice={voice} online={online} targets="real" />
          )}
        </>
      )}
    </main>
  );
}
