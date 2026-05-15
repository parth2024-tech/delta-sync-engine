// FlatBuffers-inspired schema definition for Deltasync operations.
//
// This file defines the wire format used between the CLI/WASM client
// and the server. In production, compile this with `flatc` to generate
// zero-copy reader code. The TypeScript implementation below provides
// a compatible hand-written codec.
//
// namespace deltasync;
//
// enum OpType : byte { Copy = 0, Literal = 1 }
//
// struct CopyOp {
//   block_index: uint32;
// }
//
// struct LiteralOp {
//   offset: uint32;
//   length: uint32;
// }
//
// table Op {
//   type: OpType;
//   copy: CopyOp;
//   literal: LiteralOp;
// }
//
// table OpManifest {
//   version: uint8 = 2;
//   op_count: uint32;
//   ops: [Op];
//   // Inline metadata (avoids separate JSON field)
//   block_size: uint32;
//   content_sha256: string;
// }
//
// root_type OpManifest;

export default "See TypeScript implementation in ops-flatbuf.ts";
