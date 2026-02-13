import { notFound } from "next/navigation";
import ProjectViewer from "../ProjectViewer";

const PROJECTS = {
  "boolback-results": {
    title: "BoolBack Results",
    filePath: "/home/ntheffernan/booleanbackdoors/ComplexMultiTrigger/output/results.html",
  },
} as const;

type ProjectKey = keyof typeof PROJECTS;

export default async function ProjectPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const project = PROJECTS[name as ProjectKey];
  if (!project) {
    notFound();
  }
  return <ProjectViewer title={project.title} filePath={project.filePath} />;
}
