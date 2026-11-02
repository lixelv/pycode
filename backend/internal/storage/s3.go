// Package storage is the server's side of S3. Project contents go straight
// between browsers and S3 through presigned URLs; the server itself only lists,
// copies and deletes objects, and reads the small manifests of hidden files.
package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/cors"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type Config struct {
	// Endpoint is what this server connects to; PublicEndpoint goes into URLs
	// for browsers, and into their signatures.
	Endpoint, PublicEndpoint string
	Bucket                   string
	AccessKey, SecretKey     string
	Region                   string
	UseSSL                   bool
}

type Object struct {
	Key  string
	Size int64
}

type S3 struct {
	api    *minio.Client
	public *minio.Client
	bucket string
}

// ErrTooLarge: ReadSmall found an object over its limit.
var ErrTooLarge = errors.New("object too large")

func New(_ context.Context, cfg Config) (*S3, error) {
	client := func(endpoint string) (*minio.Client, error) {
		// With the region given, presigning does not ask the network for it.
		return minio.New(endpoint, &minio.Options{
			Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
			Secure: cfg.UseSSL,
			Region: cfg.Region,
		})
	}
	api, err := client(cfg.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("s3 endpoint: %w", err)
	}
	public, err := client(cfg.PublicEndpoint)
	if err != nil {
		return nil, fmt.Errorf("s3 public endpoint: %w", err)
	}
	return &S3{api: api, public: public, bucket: cfg.Bucket}, nil
}

// EnsureDevBucket creates the bucket with CORS for one origin. Development only:
// in production the bucket and its CORS are set up by whoever runs it.
func (s *S3) EnsureDevBucket(ctx context.Context, origin string) error {
	exists, err := s.api.BucketExists(ctx, s.bucket)
	if err != nil {
		return err
	}
	if !exists {
		if err := s.api.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{}); err != nil {
			return err
		}
	}
	if origin == "" {
		return nil
	}
	return s.api.SetBucketCors(ctx, s.bucket, cors.NewConfig([]cors.Rule{{
		AllowedOrigin: []string{origin},
		AllowedMethod: []string{"GET", "PUT", "DELETE"},
		AllowedHeader: []string{"*"},
		MaxAgeSeconds: 3600,
	}}))
}

func (s *S3) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.public.Presign(ctx, http.MethodGet, s.bucket, key, ttl, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// PresignPut signs the size too, so S3 takes no other.
func (s *S3) PresignPut(ctx context.Context, key string, size int64, ttl time.Duration) (string, error) {
	u, err := s.public.PresignHeader(ctx, http.MethodPut, s.bucket, key, ttl, nil, http.Header{"Content-Length": {strconv.FormatInt(size, 10)}})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *S3) PresignDelete(ctx context.Context, key string, ttl time.Duration) (string, error) {
	u, err := s.public.Presign(ctx, http.MethodDelete, s.bucket, key, ttl, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *S3) List(ctx context.Context, prefix string) ([]Object, error) {
	var out []Object
	for o := range s.api.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if o.Err != nil {
			return nil, o.Err
		}
		out = append(out, Object{Key: o.Key, Size: o.Size})
	}
	return out, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	return s.api.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

func (s *S3) DeletePrefix(ctx context.Context, prefix string) error {
	objects, err := s.List(ctx, prefix)
	if err != nil {
		return err
	}
	keys := make(chan minio.ObjectInfo)
	go func() {
		defer close(keys)
		for _, o := range objects {
			select {
			case keys <- minio.ObjectInfo{Key: o.Key}:
			case <-ctx.Done():
				return
			}
		}
	}()
	var first error
	for result := range s.api.RemoveObjects(ctx, s.bucket, keys, minio.RemoveObjectsOptions{}) {
		if first == nil {
			first = result.Err
		}
	}
	return first
}

// Copy happens inside S3: no data passes through this server.
func (s *S3) Copy(ctx context.Context, from, to string) error {
	_, err := s.api.CopyObject(ctx, minio.CopyDestOptions{Bucket: s.bucket, Object: to}, minio.CopySrcOptions{Bucket: s.bucket, Object: from})
	return err
}

// ReadSmall reads an object of at most limit bytes.
func (s *S3) ReadSmall(ctx context.Context, key string, limit int64) ([]byte, error) {
	obj, err := s.api.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	data, err := io.ReadAll(io.LimitReader(obj, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, ErrTooLarge
	}
	return data, nil
}

// IsNotFound says whether an error of ReadSmall means the object does not exist.
func IsNotFound(err error) bool {
	return minio.ToErrorResponse(err).Code == "NoSuchKey"
}

func (s *S3) WriteSmall(ctx context.Context, key string, data []byte) error {
	_, err := s.api.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{})
	return err
}
