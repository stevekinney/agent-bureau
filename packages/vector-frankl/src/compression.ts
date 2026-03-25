/**
 * Vector compression utilities
 * Import via: vector-frankl/compression
 */
export {
  BaseCompressor,
  compareCompressionStrategies,
  type CompressedVector,
  type CompressionConfig,
  CompressionManager,
  type CompressionManagerConfig,
  type CompressionMetadata,
  type CompressionQuality,
  type CompressionRecommendation,
  compressVector,
  decompressVector,
  getCompressionRecommendation,
  type PQCodebook,
  type PQConfig,
  type PQInitMethod,
  ProductQuantizer,
  type QuantizationStrategy,
  type ScalarQuantizationConfig,
  ScalarQuantizer,
} from './compression/index.ts';
