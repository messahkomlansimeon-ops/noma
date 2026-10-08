"use client";

import { MissionForm } from "@/components/missions/mission-form";
import { SessionGate } from "@/components/session-gate";

export default function NouvelleMission() {
  return (
    <SessionGate>
      <MissionForm mode="create" />
    </SessionGate>
  );
}
