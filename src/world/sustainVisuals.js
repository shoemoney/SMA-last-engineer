import * as THREE from 'three/webgpu'

const MATERIALS = new WeakMap()

function sustainMaterials(sharedMaterial) {
  let materials = MATERIALS.get(sharedMaterial)
  if (materials) return materials
  materials = {
    heart: new THREE.MeshStandardMaterial({
      color: 0xb90824, emissive: 0xb00820, emissiveIntensity: 0.3,
      roughness: 0.4, metalness: 0.12,
    }),
    armor: new THREE.MeshStandardMaterial({
      color: 0x182831, emissive: 0x09202a, emissiveIntensity: 0.08,
      roughness: 0.5, metalness: 0.7,
    }),
    plate: new THREE.MeshStandardMaterial({
      color: 0x39606a, emissive: 0x087a91, emissiveIntensity: 0.18,
      roughness: 0.38, metalness: 0.65,
    }),
    accent: new THREE.MeshStandardMaterial({
      color: 0x26b7cd, emissive: 0x0a97ba, emissiveIntensity: 0.4,
      roughness: 0.45, metalness: 0.4,
    }),
  }
  MATERIALS.set(sharedMaterial, materials)
  return materials
}

function extrude(shape, radius, depth, bevel) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 4, steps: 1, curveSegments: 16,
  })
  geometry.translate(0, 0, -depth / 2)
  geometry.scale(radius, radius, radius)
  geometry.computeVertexNormals()
  geometry.userData.bodyRadius = radius
  return geometry
}

export function buildSustainGeometries(radius) {
  const heart = new THREE.Shape()
  heart.moveTo(0, 0.43)
  heart.bezierCurveTo(-0.22, 0.88, -0.84, 0.83, -0.84, 0.28)
  heart.bezierCurveTo(-0.84, -0.12, -0.39, -0.53, 0, -0.87)
  heart.bezierCurveTo(0.39, -0.53, 0.84, -0.12, 0.84, 0.28)
  heart.bezierCurveTo(0.84, 0.83, 0.22, 0.88, 0, 0.43)

  const armor = new THREE.Shape()
  armor.moveTo(-0.3, 0.78)
  armor.quadraticCurveTo(0, 0.25, 0.3, 0.78)
  armor.lineTo(0.62, 0.88)
  armor.lineTo(0.88, 0.65)
  armor.lineTo(0.65, 0.26)
  armor.lineTo(0.56, -0.55)
  armor.lineTo(0.34, -0.86)
  armor.lineTo(-0.34, -0.86)
  armor.lineTo(-0.56, -0.55)
  armor.lineTo(-0.65, 0.26)
  armor.lineTo(-0.88, 0.65)
  armor.lineTo(-0.62, 0.88)
  armor.closePath()

  const plate = new THREE.Shape()
  plate.moveTo(0.07, 0.39)
  plate.lineTo(0.49, 0.5)
  plate.lineTo(0.55, 0.14)
  plate.lineTo(0.39, -0.04)
  plate.lineTo(0.07, 0.02)
  plate.closePath()

  return {
    sustainHeart: extrude(heart, radius, 0.3, 0.15),
    sustainArmor: extrude(armor, radius, 0.34, 0.07),
    sustainChestPlate: extrude(plate, radius, 0.12, 0.035),
    sustainArmorRidge: new THREE.BoxGeometry(radius * 0.86, radius * 0.09, radius * 0.11),
  }
}

export function createSustainVisual(kind, geometry, material) {
  if (kind !== 'health' && kind !== 'armor') return null
  const materials = sustainMaterials(material)
  const group = new THREE.Group()
  group.name = kind === 'health' ? 'pickup:heart' : 'pickup:breastplate'
  const body = new THREE.Mesh(kind === 'health' ? geometry.sustainHeart : geometry.sustainArmor, kind === 'health' ? materials.heart : materials.armor)
  const radius = body.geometry.userData.bodyRadius
  group.position.y = radius * 1.5
  group.add(body)

  if (kind === 'armor') {
    for (const side of [-1, 1]) {
      for (const face of [-1, 1]) {
        const panel = new THREE.Mesh(geometry.sustainChestPlate, materials.plate)
        panel.scale.x = side
        panel.position.z = face * radius * 0.24
        group.add(panel)
      }
    }
    for (const y of [-0.27, -0.48]) {
      for (const face of [-1, 1]) {
        const ridge = new THREE.Mesh(geometry.sustainArmorRidge, materials.accent)
        ridge.position.set(0, y * radius, face * radius * 0.23)
        group.add(ridge)
      }
    }
  }
  return group
}
