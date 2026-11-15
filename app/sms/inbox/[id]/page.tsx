"use client";

import { useParams } from "next/navigation";
import { Thread } from "../../ui";

export default function Page() {
  const params = useParams<{ id: string }>();
  return <Thread id={params.id} />;
}
