image="test-lab-instance-cn-beijing.cr.volces.com/lidar-wwd/flatformer_wwd"
version="latest"
docker run --privileged -itd -p 38980:80 --gpus '"device=0"' --shm-size 8G --name flatformer_trt10_docker \
-v /home/mi/data/data_pkl/:/data_pkl \
${image}:${version}
