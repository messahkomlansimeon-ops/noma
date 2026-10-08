"use client";

import { useParams } from "next/navigation";
import { MissionDetail } from "@/components/missions/mission-detail";
import { SessionGate } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { isUuid } from "@/lib/client/api";
import { MISSION_NOT_FOUND } from "@/lib/client/missions-view";

export default function MissionPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <SessionGate>
      {isUuid(id) ? (
        <MissionDetail missionId={id} />
      ) : (
        <main>
          <TopBar back="/missions" title="Mission" />
          <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
            {MISSION_NOT_FOUND}
          </p>
        </main>
      )}
    </SessionGate>
  );
}
