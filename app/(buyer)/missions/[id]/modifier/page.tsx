"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { MissionForm } from "@/components/missions/mission-form";
import { SessionGate, useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
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
        <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
          {error}
        </p>
      </main>
    );
  }
  if (initial === null) {
    return (
      <main>
        <TopBar back={`/missions/${id}`} title="Modifier la mission" />
        <p className="mt-6 text-center text-[14px] text-ink-soft" aria-busy="true">
          Chargement de la mission…
        </p>
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
          <p role="alert" className="mt-6 text-center text-[14px] font-semibold text-ink">
            {MISSION_NOT_FOUND}
          </p>
        </main>
      )}
    </SessionGate>
  );
}
