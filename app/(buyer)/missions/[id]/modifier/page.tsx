"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MissionForm } from "@/components/missions/mission-form";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { ArtAlert } from "@/components/illustrations";
import { TopBar } from "@/components/top-bar";
import { EmptyState, Skeleton } from "@/components/ui";
import { isUuid } from "@/lib/client/api";
import { describeMissionError, missions } from "@/lib/client/missions-api";
import { MISSION_NOT_FOUND, formValuesOf, type MissionFormValues } from "@/lib/client/missions-view";

function EditLoader({ id }: { id: string }) {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [initial, setInitial] = useState<MissionFormValues | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    missions.get(id, { signal: controller.signal }).then(
      ({ mission }) => {
        if (!mission.canEdit) setError("Seul un brouillon se modifie.");
        else setInitial(formValuesOf(mission));
      },
      (failure) => {
        if (controller.signal.aborted || redirectIfUnauthorized(failure)) return;
        setError(describeMissionError(failure, "mission"));
      },
    );
    return () => controller.abort();
  }, [id, redirectIfUnauthorized]);

  if (error) {
    return (
      <main>
        <TopBar back={`/missions/${id}`} title="Modifier la mission" />
        <div role="alert">
          <EmptyState art={<ArtAlert className="size-32" />} title={error} />
        </div>
      </main>
    );
  }
  if (initial === null) {
    return (
      <main>
        <TopBar back={`/missions/${id}`} title="Modifier la mission" />
        <div className="flex flex-col gap-3 px-4 pt-4" aria-busy="true">
          <span className="sr-only">Chargement de la mission…</span>
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-14 w-full rounded-2xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
        </div>
      </main>
    );
  }
  return <MissionForm mode="edit" missionId={id} initial={initial} />;
}

export default function ModifierMission() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return (
    <SessionGate>
      {isUuid(id) ? (
        <EditLoader id={id} />
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
