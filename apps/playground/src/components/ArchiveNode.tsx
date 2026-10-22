import type { NodeRendererProps } from "reagraph";
import { recordColor } from "../archive";
import type { WorldNode } from "../types";

export function ArchiveNode({ node, selected, active }: NodeRendererProps) {
  const world = node.data.world as WorldNode;
  const major = world.kind === "bigEvent";
  const width = major ? 340 : world.kind === "location" ? 160 : world.kind === "dialogue" ? 145 : 115;
  const height = major ? 360 : world.kind === "location" ? 105 : world.kind === "dialogue" ? 85 : world.kind === "character" ? 165 : 135;
  const depth = major ? 48 : 22;
  const accent = recordColor(world);
  const paper = world.state === "held" ? "#3d4446" : world.state === "proposed" ? "#58492e" : world.lane === "branch" ? "#403d38" : "#343e36";
  const raised = selected || active;
  if (world.kind === "character") {
    return (
      <group position={[0, raised ? 12 : 0, raised ? 35 : 0]}>
        <mesh>
          <sphereGeometry args={[57, 36, 24]} />
          <meshStandardMaterial color={accent} metalness={0.22} roughness={0.43} transparent opacity={world.state === "proposed" ? 0.7 : 1} />
        </mesh>
        {raised && <mesh rotation={[Math.PI / 2.5, 0.2, 0]}>
          <torusGeometry args={[71, 1.4, 8, 64]} />
          <meshBasicMaterial color={accent} />
        </mesh>}
      </group>
    );
  }
  return (
    <group rotation={[0.12, -0.32, -0.025]} position={[0, raised ? 14 : 0, raised ? 50 : 0]}>
      <mesh position={[8, -8, -depth / 2 - 6]}>
        <boxGeometry args={[width, height, 12]} />
        <meshStandardMaterial color="#1c2520" roughness={0.95} />
      </mesh>
      <mesh>
        <boxGeometry args={[width, height, depth]} />
        <meshStandardMaterial color={paper} roughness={0.86} transparent opacity={world.state === "proposed" ? 0.78 : 1} />
      </mesh>
      <mesh position={[-width / 2 + 9, 0, depth / 2 + 1]}>
        <boxGeometry args={[18, height, 3]} />
        <meshStandardMaterial color={accent} roughness={0.9} />
      </mesh>
      <mesh position={[-width * 0.17, height / 2 + 13, -3]}>
        <boxGeometry args={[width * 0.42, 26, depth * 0.8]} />
        <meshStandardMaterial color={accent} roughness={0.85} />
      </mesh>
      {[0.34, -0.31].map((offset) => (
        <mesh key={offset} position={[10, height * offset, depth / 2 + 2]}>
          <boxGeometry args={[width * 0.68, 1.5, 1]} />
          <meshBasicMaterial color="#67715f" />
        </mesh>
      ))}
      <mesh position={[width * 0.33, -height * 0.4, depth / 2 + 2]}>
        <ringGeometry args={[5, 7, 24]} />
        <meshBasicMaterial color={accent} />
      </mesh>
      {major && Array.from({ length: 9 }, (_, index) => (
        <mesh key={index} position={[-width * 0.25 + index * 6, -height * 0.4, depth / 2 + 2]}>
          <boxGeometry args={[index % 3 === 0 ? 3 : 1, 14, 1]} />
          <meshBasicMaterial color="#869779" />
        </mesh>
      ))}
      {raised && <mesh position={[0, -height / 2 - 8, 1]}>
        <boxGeometry args={[width + 18, 3, depth + 12]} />
        <meshBasicMaterial color={accent} />
      </mesh>}
    </group>
  );
}
