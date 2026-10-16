"use client";

import { useParams } from "next/navigation";
import { MissionDetail } from "@/components/missions/mission-detail";
import { SessionGate } from "@/components/session-gate";
import { ArtAlert } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { EmptyState } from "@/components/ui";
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
          <div role="alert">
            <EmptyState art={<ArtAlert className="size-32" />} title={MISSION_NOT_FOUND} />
          </div>
        </main>
      )}
    </SessionGate>
  );
}
