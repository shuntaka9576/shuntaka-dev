local env = std.native('env');

{
  tag: env('IMAGE_TAG', 'latest'),
}
