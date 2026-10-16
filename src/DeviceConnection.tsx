import { useId } from 'react';
import {
  Laptop,
  LockKeyhole,
  CircleHelp,
  Smartphone,
  Tablet,
} from 'lucide-react';
import type { DeviceKind } from '@/lib/bridge/device';

const devices = {
  phone: { Icon: Smartphone, label: 'Phone' },
  tablet: { Icon: Tablet, label: 'Tablet' },
  computer: { Icon: Laptop, label: 'Computer' },
  unknown: { Icon: CircleHelp, label: 'Device' },
};

export function DeviceConnection({
  local,
  peer,
  role,
  moving,
  paused,
  http = false,
}: {
  local: DeviceKind;
  peer?: DeviceKind;
  role: 'send' | 'receive';
  moving: boolean;
  paused: boolean;
  http?: boolean;
}) {
  const sender = role === 'send' ? local : peer;
  const receiver = role === 'receive' ? local : peer;
  const state = paused ? 'Paused' : moving ? 'Transferring' : 'Ready';
  const beamId = `connection-beam-${useId().replace(/:/g, '')}`;
  const clipId = `${beamId}-clip`;
  const endpoint = (kind: DeviceKind | undefined, side: 'send' | 'receive') => {
    const { Icon, label } = devices[kind ?? 'unknown'];
    return (
      <div
        className="connection-device"
        data-device={kind ?? 'unknown'}
        title={
          kind
            ? undefined
            : 'Device type unavailable. Reopen SpeedGate on both devices to update this visual.'
        }
      >
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
        {http
          ? location.protocol === 'https:'
            ? 'HTTPS connection through local helper'
            : 'HTTP connection · local development'
          : 'Encrypted connection established'}
      </p>
      <div className={`connection-flow${moving && !paused ? ' moving' : ''}`}>
        {endpoint(sender, 'send')}
        <div className="connection-direction" aria-label={state}>
          {/* Adapted from Magic UI's MIT-licensed Animated Beam. See
              public/third-party-notices.txt. CSS animates a fixed SVG, without JS ticks. */}
          <svg
            className="connection-track"
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <defs>
              <linearGradient
                id={beamId}
                x1="-20"
                x2="0"
                y1="17"
                y2="17"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="currentColor" stopOpacity="0" />
                <stop
                  offset="32.5%"
                  stopColor="currentColor"
                  stopOpacity="0.3"
                />
                <stop offset="100%" stopColor="currentColor" />
              </linearGradient>
              <clipPath id={clipId}>
                <rect x="2" y="11" width="84" height="12" rx="6" />
              </clipPath>
            </defs>
            <path
              className="connection-rail"
              d="M 2 17 H 96"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="5 5"
              strokeLinecap="round"
            />
            <g clipPath={`url(#${clipId})`}>
              <g className="connection-beam">
                <ellipse
                  cx="0"
                  cy="17"
                  rx="4.5"
                  ry="3.5"
                  fill="currentColor"
                  opacity="0.14"
                />
                <path
                  d="M -20 17 H 0"
                  stroke={`url(#${beamId})`}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <rect
                  x="-3"
                  y="14.75"
                  width="6"
                  height="4.5"
                  rx="2.25"
                  fill="currentColor"
                />
              </g>
            </g>
            <path
              className="connection-arrowhead"
              d="m 90 12 6 5 -6 5"
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
