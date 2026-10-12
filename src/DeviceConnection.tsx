import {
  ArrowRight,
  Laptop,
  LockKeyhole,
  MonitorSmartphone,
  Smartphone,
  Tablet,
} from 'lucide-react';
import type { DeviceKind } from '@/lib/bridge/device';

const devices = {
  phone: { Icon: Smartphone, label: 'Phone' },
  tablet: { Icon: Tablet, label: 'Tablet' },
  computer: { Icon: Laptop, label: 'Computer' },
  unknown: { Icon: MonitorSmartphone, label: 'Device' },
};

export function DeviceConnection({
  local,
  peer,
  role,
  moving,
  paused,
}: {
  local: DeviceKind;
  peer?: DeviceKind;
  role: 'send' | 'receive';
  moving: boolean;
  paused: boolean;
}) {
  const sender = role === 'send' ? local : peer;
  const receiver = role === 'receive' ? local : peer;
  const state = paused ? 'Paused' : moving ? 'Transferring' : 'Ready';
  const endpoint = (kind: DeviceKind | undefined, side: 'send' | 'receive') => {
    const { Icon, label } = devices[kind ?? 'unknown'];
    return (
      <div className="connection-device" data-device={kind ?? 'unknown'}>
        <Icon size={25} aria-hidden="true" />
        <div>
          <strong>{label}</strong>
          <small>
            {side === 'send' ? 'Sender' : 'Receiver'}
            {role === side ? ' · you' : ''}
          </small>
        </div>
      </div>
    );
  };
  return (
    <div
      className="device-connection"
      role="group"
      aria-label={`${devices[sender ?? 'unknown'].label} sender to ${devices[receiver ?? 'unknown'].label} receiver`}
    >
      <p className="connected-note">
        <LockKeyhole size={14} aria-hidden="true" />
        Encrypted connection established
      </p>
      <div className={`connection-flow${moving && !paused ? ' moving' : ''}`}>
        {endpoint(sender, 'send')}
        <div className="connection-direction" aria-label={state}>
          <div className="connection-track" aria-hidden="true">
            <span className="connection-dot" />
            <ArrowRight size={15} />
          </div>
          <small>{state}</small>
        </div>
        {endpoint(receiver, 'receive')}
      </div>
    </div>
  );
}
