"use client";

import { MissionsList } from "@/components/missions/missions-list";
import { SessionGate } from "@/components/session-gate";

export default function Missions() {
  return (
    <SessionGate>
      <MissionsList />
    </SessionGate>
  );
}
