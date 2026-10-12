import { useId } from 'react';
import {
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
  const beamId = `connection-beam-${useId().replace(/:/g, '')}`;
  const endpoint = (kind: DeviceKind | undefined, side: 'send' | 'receive') => {
    const { Icon, label } = devices[kind ?? 'unknown'];
    return (
      <div className="connection-device" data-device={kind ?? 'unknown'}>
        <span className="connection-device-icon">
          <Icon size={21} strokeWidth={1.7} aria-hidden="true" />
        </span>
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
          {/* Adapted from Magic UI's MIT-licensed Animated Beam. See
              public/third-party-notices.txt. CSS animates a fixed SVG, without JS ticks. */}
          <svg
            className="connection-track"
            viewBox="0 0 100 24"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <linearGradient
                id={beamId}
                x1="-32"
                x2="-2"
                y1="12"
                y2="12"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="currentColor" stopOpacity="0" />
                <stop
                  offset="32.5%"
                  stopColor="currentColor"
                  stopOpacity="0.3"
                />
                <stop offset="75%" stopColor="currentColor" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              className="connection-rail"
              d="M 2 12 H 96"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <g className="connection-beam">
              <path
                d="M -32 12 H -2"
                stroke={`url(#${beamId})`}
                strokeWidth="3"
                strokeLinecap="round"
              />
            </g>
            <path
              d="m 90 7 6 5 -6 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <small>{state}</small>
        </div>
        {endpoint(receiver, 'receive')}
      </div>
    </div>
  );
}
